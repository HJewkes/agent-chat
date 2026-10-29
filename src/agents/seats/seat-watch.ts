import { createHash } from 'node:crypto'

/**
 * CC-1661: the seat-watch wake gate (workflows pilot P1, rule set W2). Each pass builds one state
 * packet per live seat from reads only, applies R1-R5, and records the decision. Pure: the readings
 * arrive as arguments, so a recorded packet replays through any rule-set version for free.
 */

export const RULE_SET = 'w2-v1'

/** R2: a running agent with an open PR and no activity for this long has stalled. */
export const STALE_AGENT_MS = 30 * 60_000

/** R5: the local hour of the daily digest slot. */
export const DIGEST_HOUR = 7

/** The first line of a message kept in the packet; enough to tell a report from a question. */
const FIRST_LINE_CHARS = 120

export type SenderClass = 'owner' | 'operator' | 'own-agent' | 'other'

export interface InboxItem {
  from: string
  class: SenderClass
  kind: string
  msgId: string | null
  ts: number
  firstLine: string
}

export interface AgentItem {
  name: string
  state: string
  role: string
  exitedWithoutReport: boolean
  /** Running, with no activity for `STALE_AGENT_MS`; a boolean so the packet hash moves only when it flips. */
  stale: boolean
  /** The open Shepherd run whose fixes it pushes, as `owner/repo#n`; null with none. */
  openPr: string | null
}

export interface ShepherdItem {
  ref: string
  phase: string
  implementer: string | null
  pendingGate: string | null
  stalled: boolean
  held: boolean
  needsSeat: boolean
}

export interface BudgetItem {
  implementers: number | null
  cap: number | null
  /** The stop that closes the seat's gate (budget or machine); null when open or unread. */
  stop: string | null
}

export interface Packet {
  seat: string
  inbox: InboxItem[]
  agents: AgentItem[]
  /** Null when Shepherd did not answer, which fires no R3. */
  shepherd: ShepherdItem[] | null
  /** Null when `seats status` did not answer, which fires no R4. */
  budget: BudgetItem | null
  /** Eligible queued slices; null when the scorer could not be read. */
  queue: number | null
  /** CC-1648's dispatcher covers this seat's dispatch, so R4 leaves it alone. */
  dispatcherCovers: boolean
  digestDue: boolean
}

export type RuleId = 'R1' | 'R2' | 'R3' | 'R4' | 'R5'

export interface Fired {
  rule: RuleId
  reason: string
}

export type Decision = 'wake' | 'skip'

export const firstLine = (body: string): string =>
  (body.split('\n').find(line => line.trim() !== '') ?? '').trim().slice(0, FIRST_LINE_CHARS)

/** R5 is due on the first pass at or after the slot: the previous pass ran before today's slot, or there was none today. */
export function digestDue(now: Date, previousAt: number | undefined): boolean {
  const slot = new Date(now.getFullYear(), now.getMonth(), now.getDate(), DIGEST_HOUR).getTime()
  if (now.getTime() < slot) return false
  return previousAt === undefined || previousAt < slot
}

/** JSON with object keys sorted at every depth, so equal packets serialise to equal text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export const packetHash = (packet: Packet): string =>
  createHash('sha256').update(canonicalJson(packet)).digest('hex')

const shepherdKey = (item: ShepherdItem): string =>
  [item.ref, item.phase, item.pendingGate ?? '', item.stalled, item.held].join('|')

const names = (items: readonly { name?: string; from?: string; ref?: string }[]): string =>
  items.map(i => i.name ?? i.from ?? i.ref).join(', ')

function r1(p: Packet): Fired[] {
  const unread = p.inbox.filter(i => i.class !== 'other')
  if (unread.length === 0) return []
  return [
    { rule: 'R1', reason: `${unread.length} unread from owner, operator or own agent: ${names(unread)}` },
  ]
}

function r2(p: Packet): Fired[] {
  const silent = p.agents.filter(a => a.exitedWithoutReport)
  const stale = p.agents.filter(a => a.stale && a.openPr !== null)
  const reasons = [
    ...(silent.length === 0 ? [] : [`exited with no report: ${names(silent)}`]),
    ...(stale.length === 0 ? [] : [`stale over 30 min with an open PR: ${names(stale)}`]),
  ]
  return reasons.length === 0 ? [] : [{ rule: 'R2', reason: reasons.join('; ') }]
}

/** R3 fires on a change only: a seat item already needing the seat at the last pass was raised then. */
function r3(p: Packet, previous: Packet | undefined): Fired[] {
  if (p.shepherd === null) return []
  const before = new Set((previous?.shepherd ?? []).filter(i => i.needsSeat).map(shepherdKey))
  const changed = p.shepherd.filter(i => i.needsSeat && !before.has(shepherdKey(i)))
  if (changed.length === 0) return []
  return [
    { rule: 'R3', reason: `Shepherd needs the seat: ${changed.map(i => `${i.ref} ${i.phase}`).join(', ')}` },
  ]
}

function r4(p: Packet): Fired[] {
  const b = p.budget
  if (b === null || b.implementers === null || b.cap === null || b.stop !== null) return []
  if (b.implementers >= b.cap || p.queue === null || p.queue === 0 || p.dispatcherCovers) return []
  return [{ rule: 'R4', reason: `${b.cap - b.implementers} free implementer slot(s), ${p.queue} eligible` }]
}

const r5 = (p: Packet): Fired[] => (p.digestDue ? [{ rule: 'R5', reason: 'daily digest slot' }] : [])

/** `previous` is the packet the seat's last pass recorded; R3 compares against it. */
export function applyRules(packet: Packet, previous: Packet | undefined): Fired[] {
  return [...r1(packet), ...r2(packet), ...r3(packet, previous), ...r4(packet), ...r5(packet)]
}

export const decisionOf = (fired: readonly Fired[]): Decision => (fired.length === 0 ? 'skip' : 'wake')

/** How one source read went: its latency, and its error when it failed. */
export interface ReadNote {
  ms: number
  error?: string
}

export interface WatchRow {
  at: string
  seat: string
  ruleSet: string
  shadow: boolean
  hash: string
  /** The hash equals the seat's previous row's: nothing changed since that pass. */
  unchanged: boolean
  decision: Decision
  fired: Fired[]
  /** Set when not in shadow: the sender's outcome. */
  delivery?: 'delivered' | 'refused'
  reads: Record<string, ReadNote>
  packet: Packet
}

export interface RowInput {
  now: Date
  packet: Packet
  previous: Pick<WatchRow, 'hash' | 'packet'> | undefined
  shadow: boolean
  reads: Record<string, ReadNote>
}

export function watchRow(input: RowInput): WatchRow {
  const { packet, previous } = input
  const hash = packetHash(packet)
  const fired = applyRules(packet, previous?.packet)
  return {
    at: input.now.toISOString(),
    seat: packet.seat,
    ruleSet: RULE_SET,
    shadow: input.shadow,
    hash,
    unchanged: previous?.hash === hash,
    decision: decisionOf(fired),
    fired,
    reads: input.reads,
    packet,
  }
}
