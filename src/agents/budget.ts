import fs from 'node:fs'
import path from 'node:path'
import { accountName } from './config-dir.js'
import { configDir } from './transcript.js'
import { readTranscriptUsage, type TranscriptUsage } from './transcript-usage.js'
import type { SlotUsage } from './semaphore.js'

/**
 * What a Claude Code session is spending — context window and account rate
 * limits — read from a file the session's own status line writes.
 *
 * NOTHING HERE OBSERVES ANYTHING ITSELF, and that is the whole shape of the
 * problem. A running session's context fill is known to Claude Code and to no
 * one else: the MCP subprocess cannot see the conversation, the transcript on
 * disk carries per-message usage but not the live window, and no API answers
 * "how full is that session". The one place the number is already handed to a
 * user-owned process is the status line, which Claude Code invokes with the
 * whole payload on stdin. So this module reads a cache the status line writes,
 * and every miss below is a normal state rather than an error: the writer is
 * not installed, the session has no status line, or it has not refreshed yet.
 *
 * Staleness is therefore load-bearing, not decoration. The status line only runs
 * when Claude Code redraws it, so a session idle at a permission prompt keeps
 * publishing the fill it had when it stopped. A caller pacing work on this must
 * be able to tell "43% as of four seconds ago" from "43% as of an hour ago".
 */

/** One account rate-limit window as the status line reports it. */
export interface BudgetWindow {
  used_pct: number
  /** Unix seconds. Absent when the payload carried none. */
  resets_at?: number
}

export interface SessionBudget {
  session_id: string
  cwd?: string
  model_id?: string
  /** Unix seconds, stamped by the writer, not by Claude Code. */
  written_at: number
  context: {
    used_pct?: number
    remaining_pct?: number
    window_size?: number
    input_tokens?: number
    output_tokens?: number
    cache_read_tokens?: number
    cache_creation_tokens?: number
    exceeds_200k: boolean
  }
  cost: {
    total_cost_usd?: number
    total_duration_ms?: number
    total_api_duration_ms?: number
    lines_added?: number
    lines_removed?: number
  }
  /**
   * Keyed by window name — `five_hour`, `seven_day`, and `spend_limit` on a
   * gateway account. Deliberately open rather than a closed record: the set is
   * Claude Code's to change, and a build that starts emitting a fourth window
   * should surface it here without a code change on this side.
   */
  rate_limits: Record<string, BudgetWindow>
  /** Reasoning effort level, present only when the model supports it. */
  effort?: string
  /** Absent before the session's first API response and on Claude Code builds that predate it. */
  prompt_cache?: PromptCache
}

/** The subset of Claude Code's `prompt_cache` status-line object the writer keeps. */
export interface PromptCache {
  /** As of the write, not now: pair it with `expires_at` before trusting it. */
  warm?: boolean
  caching_observed?: boolean
  /** `5m` or `1h` as observed on 2.1.280. */
  ttl?: string
  /** Unix seconds. */
  expires_at?: number
}

/**
 * Two status-line refreshes apart. The status line redraws on every assistant
 * message and on its own `refreshInterval`, so anything older than this means
 * the session is idle or the writer stopped, not that it is between turns.
 */
export const STALE_AFTER_SECONDS = 120

/** The oldest reading a budget gate trusts; an older one may hide spend since. */
export const MAX_ACCOUNT_READING_AGE_SECONDS = 15 * 60

export type BudgetMiss = 'no_file' | 'unreadable' | 'malformed'

/** Absent means the status line wrote it; `transcript` means it was derived from usage (CC-179). */
export type BudgetSource = 'transcript'

export type BudgetRead =
  | {
      found: true
      path: string
      budget: SessionBudget
      age_seconds: number
      stale: boolean
      source?: BudgetSource
    }
  | { found: false; path: string; reason: BudgetMiss; transcript_miss?: string }

/**
 * `dir` is the Claude config dir to read under, for the same reason
 * `transcript.ts` takes one: the status line writes into the cache of the account
 * its own session runs on, so an agent on a different account publishes somewhere
 * this process's environment does not point (CC-100). Omitted means this process's
 * own, which is right for the broker's session and for the human at the CLI.
 */
export const budgetDir = (dir?: string): string =>
  process.env.AGENT_CHAT_STATUS_CACHE ?? path.join(dir ?? configDir(), 'status-cache', 'sessions')

/**
 * A session id reaches us from the registry, which got it from a peer's
 * environment — not from a model. It is a uuid in every case observed, but it
 * is still a string arriving from another process and it is about to become a
 * path segment, so it is constrained here rather than trusted.
 */
export const budgetPath = (sessionId: string, dir?: string): string =>
  path.join(budgetDir(dir), `${safeSessionId(sessionId)}.json`)

const SESSION_ID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/

function safeSessionId(sessionId: string): string {
  if (!SESSION_ID_SHAPE.test(sessionId)) throw new Error(`unusable session id: ${sessionId}`)
  return sessionId
}

/**
 * A status-line reading when there is one, else the transcript's last usage
 * record (CC-179), so a headless agent that never draws a status line still
 * reports its fill. Account-level readers use {@link readStatusLineBudget}
 * instead, because a transcript carries no rate limits.
 */
export function readBudget(sessionId: string, now = Date.now(), dir?: string, cwd?: string): BudgetRead {
  const statusLine = readStatusLineBudget(sessionId, now, dir)
  if (statusLine.found || !SESSION_ID_SHAPE.test(sessionId)) return statusLine
  const usage = readTranscriptUsage(sessionId, dir, cwd)
  if (!usage.ok) return { ...statusLine, transcript_miss: `${usage.reason} (${usage.path})` }
  const age = Math.max(0, Math.round(now / 1000 - usage.recorded_at))
  return {
    found: true,
    path: usage.path,
    budget: transcriptBudget(sessionId, usage),
    age_seconds: age,
    stale: age > STALE_AFTER_SECONDS,
    source: 'transcript',
  }
}

/** No window size: nothing in this codebase maps a model id to one, so the percentage stays unknown. */
function transcriptBudget(sessionId: string, usage: TranscriptUsage): SessionBudget {
  const total = usage.input_tokens + usage.cache_read_tokens + usage.cache_creation_tokens
  return {
    session_id: sessionId,
    ...defined('model_id', usage.model),
    written_at: usage.recorded_at,
    context: {
      input_tokens: total,
      output_tokens: usage.output_tokens,
      cache_read_tokens: usage.cache_read_tokens,
      cache_creation_tokens: usage.cache_creation_tokens,
      exceeds_200k: total > 200_000,
    },
    cost: {},
    rate_limits: {},
  }
}

export function readStatusLineBudget(sessionId: string, now = Date.now(), dir?: string): BudgetRead {
  let file: string
  try {
    file = budgetPath(sessionId, dir)
  } catch {
    return { found: false, path: budgetDir(dir), reason: 'malformed' }
  }

  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return { found: false, path: file, reason: fs.existsSync(file) ? 'unreadable' : 'no_file' }
  }

  const budget = parseBudget(raw)
  if (budget === null) return { found: false, path: file, reason: 'malformed' }

  const age = Math.max(0, Math.round(now / 1000 - budget.written_at))
  return { found: true, path: file, budget, age_seconds: age, stale: age > STALE_AFTER_SECONDS }
}

/**
 * Tolerant by design. The writer is a shell script in the user's `~/.claude`,
 * upgraded independently of this binary, so a field it stopped sending must
 * degrade to `undefined` rather than reject the whole document.
 */
export function parseBudget(raw: string): SessionBudget | null {
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(doc)) return null

  const sessionId = str(doc.session_id)
  const writtenAt = num(doc.written_at)
  if (sessionId === undefined || writtenAt === undefined) return null

  const context = isRecord(doc.context) ? doc.context : {}
  const cost = isRecord(doc.cost) ? doc.cost : {}
  return {
    session_id: sessionId,
    ...defined('cwd', str(doc.cwd)),
    ...defined('model_id', str(doc.model_id)),
    written_at: writtenAt,
    context: parseContext(context),
    cost: parseCost(cost),
    rate_limits: parseWindows(doc.rate_limits),
    ...defined('effort', str(doc.effort)),
    ...defined('prompt_cache', parsePromptCache(doc.prompt_cache)),
  }
}

function parsePromptCache(raw: unknown): PromptCache | undefined {
  if (!isRecord(raw)) return undefined
  return {
    ...defined('warm', bool(raw.warm)),
    ...defined('caching_observed', bool(raw.caching_observed)),
    ...defined('ttl', str(raw.ttl)),
    ...defined('expires_at', num(raw.expires_at)),
  }
}

/**
 * Tokens in the context right now. `input_tokens` is Claude Code's
 * `total_input_tokens`, which 2.1.280 computes as input + cache_creation +
 * cache_read of the latest usage, so it is exact; the percentage is 1% steps.
 */
export function contextTokens(context: SessionBudget['context']): number | undefined {
  if (context.input_tokens !== undefined && context.input_tokens > 0) return context.input_tokens
  if (context.used_pct === undefined || context.window_size === undefined) return undefined
  return Math.round((context.used_pct / 100) * context.window_size)
}

function parseContext(raw: Record<string, unknown>): SessionBudget['context'] {
  return {
    ...defined('used_pct', num(raw.used_pct)),
    ...defined('remaining_pct', num(raw.remaining_pct)),
    ...defined('window_size', num(raw.window_size)),
    ...defined('input_tokens', num(raw.input_tokens)),
    ...defined('output_tokens', num(raw.output_tokens)),
    ...defined('cache_read_tokens', num(raw.cache_read_tokens)),
    ...defined('cache_creation_tokens', num(raw.cache_creation_tokens)),
    exceeds_200k: raw.exceeds_200k === true,
  }
}

function parseCost(raw: Record<string, unknown>): SessionBudget['cost'] {
  return {
    ...defined('total_cost_usd', num(raw.total_cost_usd)),
    ...defined('total_duration_ms', num(raw.total_duration_ms)),
    ...defined('total_api_duration_ms', num(raw.total_api_duration_ms)),
    ...defined('lines_added', num(raw.lines_added)),
    ...defined('lines_removed', num(raw.lines_removed)),
  }
}

function parseWindows(raw: unknown): Record<string, BudgetWindow> {
  if (!isRecord(raw)) return {}
  const windows: Record<string, BudgetWindow> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue
    const used = num(value.used_percentage) ?? num(value.used_pct)
    if (used === undefined) continue
    windows[name] = { used_pct: used, ...defined('resets_at', num(value.resets_at)) }
  }
  return windows
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** Keeps `exactOptionalPropertyTypes` honest: an absent field is absent, never `undefined`. */
const defined = <K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> =>
  value === undefined ? {} : ({ [key]: value } as Record<K, V>)

/**
 * Why a miss is a miss, in words the caller can act on. NOT_FOUND is the common
 * case on a machine where the status-line writer was never installed, so it says
 * how to install it rather than only that something is absent.
 */
export function budgetMiss(who: string, read: Extract<BudgetRead, { found: false }>): string {
  const tail =
    read.reason === 'no_file'
      ? 'Nothing has written it. Either that session has no status line, or the status-line writer ' +
        'is not installed — see docs/context-budget-research.md for the one line it needs.'
      : `The file is present but ${read.reason}; treat this as no reading rather than as zero usage.`
  const transcript =
    read.transcript_miss === undefined ? '' : ` Transcript fallback: ${read.transcript_miss}.`
  return `NOT_FOUND: no budget reading for ${who} (${read.path}). ${tail}${transcript}`
}

/**
 * One account's rate limits for a reader (CC-491). Read from the account, never
 * from the session being reported: two sessions in one weekly window carry the
 * same resets_at, so a 46 h old session row looks current while it is not.
 */
export interface AccountReading {
  name: string
  config_dir: string
  read: BudgetRead
}

export const readAccount = (dir: string, now = Date.now()): AccountReading => ({
  name: accountName(dir),
  config_dir: dir,
  read: readAccountBudget(dir, now),
})

/** Reads each config dir once per call; an empty or absent dir is this process's own, as in {@link readBudget}. */
export function accountReader(now = Date.now()): (dir?: string) => AccountReading {
  const seen = new Map<string, AccountReading>()
  return dir => {
    const key = dir || configDir()
    const reading = seen.get(key) ?? readAccount(key, now)
    seen.set(key, reading)
    return reading
  }
}

const isCurrent = (read: FoundRead): boolean => read.age_seconds <= MAX_ACCOUNT_READING_AGE_SECONDS

const windowsText = (rateLimits: Record<string, BudgetWindow>): string => {
  const windows = Object.entries(rateLimits).map(([name, w]) => `${name} ${round(w.used_pct)}%`)
  return windows.length > 0 ? windows.join(', ') : 'no account rate-limit windows in the payload'
}

/** Never the windows of a reading past 15 minutes: only its age, so nobody paces on it. */
function accountLine(label: string, { name, read }: AccountReading): string {
  if (!read.found) return `${label} on ${name}: no budget reading.`
  if (!isCurrent(read))
    return `${label} on ${name}: STALE — newest reading is ${read.age_seconds}s old, not a current figure.`
  return `${label} on ${name} (${read.age_seconds}s old): ${windowsText(read.budget.rate_limits)}.`
}

function accountJson({ name, config_dir, read }: AccountReading): Record<string, unknown> {
  if (!read.found) return { name, config_dir, found: false }
  const current = isCurrent(read)
  return {
    name,
    config_dir,
    age_seconds: read.age_seconds,
    stale: !current,
    ...(current ? { rate_limits: read.budget.rate_limits } : {}),
  }
}

/** The session's own rate limits are dropped: the account block is the one figure. */
const budgetJson = (budget: SessionBudget, extra: Record<string, unknown>): string =>
  JSON.stringify({
    ...Object.fromEntries(Object.entries(budget).filter(([key]) => key !== 'rate_limits')),
    ...extra,
  })

export function formatBudget(
  who: string,
  read: Extract<BudgetRead, { found: true }>,
  account: AccountReading,
): string {
  if (read.source === 'transcript') return formatTranscriptBudget(who, read, account)
  const { budget, age_seconds, stale } = read
  const freshness = stale
    ? `STALE — last written ${age_seconds}s ago, so this is what ${who} was spending when it last redrew`
    : `${age_seconds}s old`
  return [
    `${who}: ${contextLine(budget)} (${freshness}).`,
    accountLine('Account', account),
    `json: ${budgetJson(budget, { age_seconds, stale, account: accountJson(account) })}`,
  ].join('\n')
}

function formatTranscriptBudget(
  who: string,
  read: Extract<BudgetRead, { found: true }>,
  account: AccountReading,
): string {
  const { budget, age_seconds, stale, source } = read
  const freshness = stale
    ? `STALE — last usage record ${age_seconds}s ago, so this is the fill as of ${who}'s last API response`
    : `last usage record ${age_seconds}s old`
  return [
    `${who}: ${transcriptContext(budget)} (source: transcript, ${freshness}).`,
    accountLine('Account', account),
    `json: ${budgetJson(budget, { age_seconds, stale, source, account: accountJson(account) })}`,
  ].join('\n')
}

const transcriptContext = (budget: SessionBudget): string =>
  `${Math.round((budget.context.input_tokens ?? 0) / 1000)}k tokens of context, window unknown` +
  (budget.context.exceeds_200k ? ', past 200k' : '')

function contextLine(budget: SessionBudget): string {
  const { used_pct, window_size, cache_read_tokens, cache_creation_tokens } = budget.context
  const pct = used_pct === undefined ? 'unknown %' : `${round(used_pct)}%`
  const size = window_size === undefined ? 'context' : `${Math.round(window_size / 1000)}k context`
  const cached = (cache_read_tokens ?? 0) + (cache_creation_tokens ?? 0)
  const cachedPart = cached > 0 ? `, ${Math.round(cached / 1000)}k cached` : ''
  return `${pct} of ${size}${cachedPart}${budget.context.exceeds_200k ? ', past 200k' : ''}`
}

const round = (n: number): number => Math.round(n * 10) / 10

/** A row's budget reading paired with the roster name it belongs to (CC-94). */
export interface NamedBudgetRead {
  name: string
  read: BudgetRead
}

/**
 * One compact segment for a roster row (CC-94) — model, cost and context fill,
 * in about as much text as an existing status tag. Rate limits are deliberately
 * excluded: they are account-wide, not per session, and belong once in the
 * roster header via {@link accountUsageLine} rather than repeated on every row.
 *
 * Staleness is surfaced rather than smoothed over, reusing the same
 * `age_seconds`/`stale` this module already computes in {@link readBudget} —
 * an idle session keeps publishing the fill it had when it stopped, and a
 * reader must be able to tell that from a live number.
 */
export function budgetSegment(read: BudgetRead): string {
  if (!read.found) return 'no budget reading'
  const { budget, age_seconds, stale } = read
  if (read.source === 'transcript') {
    const parts = [budget.model_id, transcriptContext(budget)].filter((p): p is string => p !== undefined)
    return `${parts.join(' · ')} [transcript${stale ? `, stale ${age_seconds}s` : ''}]`
  }
  const { used_pct, window_size } = budget.context
  const pct = used_pct === undefined ? undefined : `${round(used_pct)}%`
  const size = window_size === undefined ? undefined : `${Math.round(window_size / 1000)}k`
  const context = pct === undefined ? undefined : size === undefined ? pct : `${pct}/${size}`
  const cost = budget.cost.total_cost_usd === undefined ? undefined : `$${round(budget.cost.total_cost_usd)}`
  const parts = [budget.model_id, cost, context].filter((p): p is string => p !== undefined)
  const rendered = parts.length > 0 ? parts.join(' · ') : 'no budget reading'
  return stale ? `${rendered} [stale ${age_seconds}s]` : rendered
}

/**
 * One line for a roster's header. Account rate-limit windows are the same
 * figure for every session under one account, so printing them per row would
 * repeat one fact N times rather than report N facts — this reads them once,
 * from whichever row's reading is freshest, and says whose and how old.
 *
 * `slots` (CC-139) rides on the same line rather than a second one, and is
 * omitted rather than printed as "unknown" when the broker reply predates it.
 */
export function accountUsageLine(budgets: NamedBudgetRead[], slots?: SlotUsage): string {
  const found = budgets
    .map(b => (b.read.found && b.read.source === undefined ? { name: b.name, ...b.read } : undefined))
    .filter((b): b is { name: string } & Extract<BudgetRead, { found: true }> => b !== undefined)
  const suffix = slots === undefined ? '' : ` · slots ${slots.held}/${slots.cap}`
  if (found.length === 0) return `Account usage: no budget reading available from any row.${suffix}`

  const freshest = found.reduce((a, b) => (b.age_seconds < a.age_seconds ? b : a))
  if (!isCurrent(freshest))
    return `Account usage: STALE — newest reading (${freshest.name}'s) is ${freshest.age_seconds}s old, not a current figure.${suffix}`
  const usage = windowsText(freshest.budget.rate_limits)
  return `Account usage (from ${freshest.name}'s reading, ${freshest.age_seconds}s old): ${usage}.${suffix}`
}

/**
 * The agent_list header (CC-491): one line per account, each from the freshest
 * reading under that account's config dir. The slot figure rides on the first.
 */
export function accountUsageLines(accounts: AccountReading[], slots?: SlotUsage): string {
  const suffix = slots === undefined ? '' : ` · slots ${slots.held}/${slots.cap}`
  if (!accounts.some(a => a.read.found))
    return `Account usage: no budget reading available from any row.${suffix}`
  return accounts
    .map((account, i) => `${accountLine('Account usage', account)}${i === 0 ? suffix : ''}`)
    .join('\n')
}

type FoundRead = Extract<BudgetRead, { found: true }>

/**
 * The account-level figure for one config dir: the freshest reading of any
 * session under it, since rate-limit windows are the same for all of them.
 * A stale reading is still returned; usage only falls at resets, so it errs high.
 */
export function readAccountBudget(dir: string, now = Date.now()): BudgetRead {
  const cache = budgetDir(dir)
  let files: string[]
  try {
    files = fs.readdirSync(cache).filter(name => name.endsWith('.json'))
  } catch {
    return { found: false, path: cache, reason: 'no_file' }
  }
  const reads = files
    .map(name => readStatusLineBudget(name.slice(0, -'.json'.length), now, dir))
    .filter((read): read is FoundRead => read.found)
  if (reads.length === 0) return { found: false, path: cache, reason: 'no_file' }
  return mergeWindows(reads, now)
}

/**
 * CC-895: the newest file, with each window it lacks taken whole from the freshest other file that has it.
 * A status line drops five_hour after its reset while the usage poller's file still carries it. Only a
 * fresh file lends a window, and never one whose reset has passed; the result is as old as its oldest lender.
 */
export function mergeWindows(reads: readonly FoundRead[], now: number): FoundRead {
  const [newest, ...rest] = [...reads].sort((a, b) => b.budget.written_at - a.budget.written_at) as [
    FoundRead,
    ...FoundRead[],
  ]
  const rate_limits = { ...newest.budget.rate_limits }
  let age = newest.age_seconds
  for (const read of rest.filter(r => r.age_seconds <= MAX_ACCOUNT_READING_AGE_SECONDS))
    for (const [name, window] of Object.entries(read.budget.rate_limits)) {
      if (name in rate_limits || (window.resets_at !== undefined && window.resets_at * 1000 <= now)) continue
      rate_limits[name] = window
      age = Math.max(age, read.age_seconds)
    }
  return {
    ...newest,
    budget: { ...newest.budget, rate_limits },
    age_seconds: age,
    stale: age > STALE_AFTER_SECONDS,
  }
}
