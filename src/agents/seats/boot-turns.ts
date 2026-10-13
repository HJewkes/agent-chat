import { priceRequest } from '@titan-design/session-analytics'

/**
 * CC-318: how much of a seat generation's opening is spent reading boot state, measured from its transcript.
 *
 * A turn is one API response. Claude Code writes one record per content block, each carrying the response's
 * id and usage, so a turn's tool calls are the union over its records and its usage is the last record's.
 * Sidechain records are a subagent's turns, not the seat's, and are skipped. Read-only: no file is written.
 */

export interface ToolCall {
  name: string
  input: Record<string, unknown>
}

export interface GenerationBoot {
  /** The seat named by the generation's first prompt, or undefined for a session that is not a seat. */
  seat: string | undefined
  startedAt: string | undefined
  /** Turns read, at most the window. */
  turns: number
  /** Turns in the window with at least one BOOT_CLASS call. */
  bootTurns: number
  /** List price of the window's turns, or null when a model there has no price row. */
  usd: number | null
  usedSeatsBoot: boolean
  /** msg_ids listed under a boot `== inbox` heading. */
  inboxShown: string[]
  /** Of those, the ones no later assistant record mentions. */
  inboxUnmentioned: string[]
}

export interface BootTurnsOptions {
  window?: number
  seatPatterns?: readonly RegExp[]
}

export const BOOT_WINDOW = 10

/** Each captures the seat name; the forms the relaunch handoff, teleport and charter prompts have used. */
export const SEAT_PATTERNS: readonly RegExp[] = [
  /Register as ([\w-]+) with chat_register/,
  /You are ([\w-]+) \(TELEPORT/,
  /Run the autonomy charter\b[^\n]*?\bas seat ([\w-]+)/,
]

const BOOT_READ = /autonomy\/(seats|queues?|logs)\/|charter\.md|decisions\.md/
const BOOT_MCP = /(chat_inbox|chat_list|session_budget|agent_list|chat_register)$/
const BOOT_BASH = /agent-chat (seats (boot|status)|agent ls)|aw (task list|list)/
const SEATS_BOOT = /agent-chat seats boot/
const SYNTHETIC = '<synthetic>'

/** BOOT_CLASS: a tool call that reads seat, queue, inbox or roster state rather than doing the seat's work. */
export function isBootCall({ name, input }: ToolCall): boolean {
  if (name === 'ToolSearch') return true
  if (name === 'Read') return BOOT_READ.test(text(input.file_path) ?? '')
  if (name === 'Bash') return BOOT_BASH.test(text(input.command) ?? '')
  return name.startsWith('mcp__') && BOOT_MCP.test(name)
}

interface Turn {
  calls: ToolCall[]
  model: string
  ts: string
  usage: Record<string, unknown>
}

interface Scan {
  seat: string | undefined
  prompted: boolean
  startedAt: string | undefined
  turns: Map<string, Turn>
  usedSeatsBoot: boolean
  shown: string[]
  pending: Set<string>
}

export function bootTurns(lines: Iterable<string>, opts: BootTurnsOptions = {}): GenerationBoot {
  const scan: Scan = {
    seat: undefined,
    prompted: false,
    startedAt: undefined,
    turns: new Map(),
    usedSeatsBoot: false,
    shown: [],
    pending: new Set(),
  }
  for (const line of lines) {
    const record = parseLine(line)
    if (record !== undefined && record.isSidechain !== true)
      observe(scan, record, opts.seatPatterns ?? SEAT_PATTERNS)
  }
  const window = [...scan.turns.values()].slice(0, opts.window ?? BOOT_WINDOW)
  return {
    seat: scan.seat,
    startedAt: scan.startedAt,
    turns: window.length,
    bootTurns: window.filter(turn => turn.calls.some(isBootCall)).length,
    usd: usdOf(window),
    usedSeatsBoot: scan.usedSeatsBoot,
    inboxShown: scan.shown,
    inboxUnmentioned: scan.shown.filter(id => scan.pending.has(id)),
  }
}

function observe(scan: Scan, record: Record<string, unknown>, seatPatterns: readonly RegExp[]): void {
  scan.startedAt ??= text(record.timestamp)
  const message = isRecord(record.message) ? record.message : undefined
  if (message === undefined) return
  if (record.type === 'user') observeUser(scan, message.content, seatPatterns)
  if (record.type === 'assistant' && message.model !== SYNTHETIC) observeAssistant(scan, record, message)
}

function observeUser(scan: Scan, content: unknown, seatPatterns: readonly RegExp[]): void {
  const results = blocks(content).filter(block => block.type === 'tool_result')
  for (const result of results) {
    for (const id of inboxIds(contentText(result.content))) {
      if (scan.shown.includes(id)) continue
      scan.shown.push(id)
      scan.pending.add(id)
    }
  }
  if (scan.prompted || results.length > 0) return
  scan.prompted = true
  scan.seat = seatOf(contentText(content), seatPatterns)
}

function observeAssistant(
  scan: Scan,
  record: Record<string, unknown>,
  message: Record<string, unknown>,
): void {
  const said = JSON.stringify(message.content ?? '')
  for (const id of scan.pending) if (said.includes(id)) scan.pending.delete(id)
  const id = text(message.id)
  if (id === undefined) return
  const turn = scan.turns.get(id) ?? { calls: [], model: '', ts: '', usage: {} }
  turn.model = text(message.model) ?? 'unknown'
  turn.ts = text(record.timestamp) ?? turn.ts
  if (isRecord(message.usage)) turn.usage = message.usage
  turn.calls.push(...toolCalls(message.content))
  scan.usedSeatsBoot ||= turn.calls.some(
    call => call.name === 'Bash' && SEATS_BOOT.test(text(call.input.command) ?? ''),
  )
  scan.turns.set(id, turn)
}

export function seatOf(prompt: string, patterns: readonly RegExp[] = SEAT_PATTERNS): string | undefined {
  for (const pattern of patterns) {
    const seat = pattern.exec(prompt)?.[1]
    if (seat !== undefined) return seat
  }
  return undefined
}

/** The ids under a boot `== inbox` heading, up to the next `==` heading; lines read `[<msg_id>] from <name>: ...`. */
export function inboxIds(output: string): string[] {
  const ids: string[] = []
  let inInbox = false
  for (const line of output.split('\n')) {
    if (line.startsWith('== ')) inInbox = line.startsWith('== inbox')
    const id = inInbox ? /^\[([\w-]+)\] from /.exec(line)?.[1] : undefined
    if (id !== undefined) ids.push(id)
  }
  return ids
}

function toolCalls(content: unknown): ToolCall[] {
  return blocks(content)
    .filter(block => block.type === 'tool_use' && typeof block.name === 'string')
    .map(block => ({ name: block.name as string, input: isRecord(block.input) ? block.input : {} }))
}

function usdOf(turns: readonly Turn[]): number | null {
  let usd = 0
  for (const turn of turns) {
    const priced = priceRequest(usageOf(turn.usage), turn.model, turn.ts)
    if (!priced.priced) return null
    usd += priced.costUsd
  }
  return Math.round(usd * 1e4) / 1e4
}

/** A record without the 5m/1h split counts its whole cache write as 5m, as `transcript-spend.ts` does. */
function usageOf(usage: Record<string, unknown>) {
  const split = isRecord(usage.cache_creation) ? usage.cache_creation : {}
  const write5m = count(split.ephemeral_5m_input_tokens)
  const write1h = count(split.ephemeral_1h_input_tokens)
  return {
    inputTokens: count(usage.input_tokens),
    cacheReadTokens: count(usage.cache_read_input_tokens),
    cacheCreation5mTokens: write5m + write1h === 0 ? count(usage.cache_creation_input_tokens) : write5m,
    cacheCreation1hTokens: write1h,
    outputTokens: count(usage.output_tokens),
  }
}

export interface BootRow {
  generations: number
  /** Generations with fewer turns than the window; left out of the two means. */
  short: number
  meanBootTurns: number | null
  meanUsd: number | null
  /** Share of generations that ran `agent-chat seats boot`, 0..1. */
  seatsBootShare: number | null
  unmentioned: string[]
}

export interface BootSummary {
  total: BootRow
  seats: Record<string, BootRow>
}

/** Per-seat and total rows over seat generations; a generation with no seat is not a seat's and is skipped. */
export function summarise(gens: readonly GenerationBoot[], window = BOOT_WINDOW): BootSummary {
  const seated = gens.filter(gen => gen.seat !== undefined)
  const seats: Record<string, BootRow> = {}
  for (const seat of [...new Set(seated.map(gen => gen.seat as string))].sort()) {
    seats[seat] = rowOf(
      seated.filter(gen => gen.seat === seat),
      window,
    )
  }
  return { total: rowOf(seated, window), seats }
}

function rowOf(gens: readonly GenerationBoot[], window: number): BootRow {
  const full = gens.filter(gen => gen.turns >= window)
  const priced = full.map(gen => gen.usd).filter((usd): usd is number => usd !== null)
  return {
    generations: gens.length,
    short: gens.length - full.length,
    meanBootTurns: mean(full.map(gen => gen.bootTurns)),
    meanUsd: mean(priced, 4),
    seatsBootShare: mean(
      gens.map(gen => (gen.usedSeatsBoot ? 1 : 0)),
      3,
    ),
    unmentioned: gens.flatMap(gen => gen.inboxUnmentioned),
  }
}

/** How far `after` fell below `before`, in percent to one place. */
export function fallPct(before: number, after: number): number {
  return Math.round(((before - after) / before) * 1000) / 10
}

function mean(values: readonly number[], places = 2): number | null {
  if (values.length === 0) return null
  const scale = 10 ** places
  return Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * scale) / scale
}

function blocks(content: unknown): Record<string, unknown>[] {
  return Array.isArray(content) ? content.filter(isRecord) : []
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  return blocks(content)
    .map(block => text(block.text) ?? '')
    .join('\n')
}

function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const doc: unknown = JSON.parse(line)
    return isRecord(doc) ? doc : undefined
  } catch {
    return undefined
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
