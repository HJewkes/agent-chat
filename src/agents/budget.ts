import fs from 'node:fs'
import path from 'node:path'
import { configDir } from './transcript.js'
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

export type BudgetMiss = 'no_file' | 'unreadable' | 'malformed'

export type BudgetRead =
  | { found: true; path: string; budget: SessionBudget; age_seconds: number; stale: boolean }
  | { found: false; path: string; reason: BudgetMiss }

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

export function readBudget(sessionId: string, now = Date.now(), dir?: string): BudgetRead {
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
  return `NOT_FOUND: no budget reading for ${who} (${read.path}). ${tail}`
}

export function formatBudget(who: string, read: Extract<BudgetRead, { found: true }>): string {
  const { budget, age_seconds, stale } = read
  const freshness = stale
    ? `STALE — last written ${age_seconds}s ago, so this is what ${who} was spending when it last redrew`
    : `${age_seconds}s old`
  const windows = Object.entries(budget.rate_limits).map(([name, w]) => `${name} ${round(w.used_pct)}%`)
  const account = windows.length > 0 ? windows.join(', ') : 'no account rate-limit windows in the payload'
  return [
    `${who}: ${contextLine(budget)} (${freshness}).`,
    `Account: ${account}.`,
    `json: ${JSON.stringify({ ...budget, age_seconds, stale })}`,
  ].join('\n')
}

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
    .map(b => (b.read.found ? { name: b.name, ...b.read } : undefined))
    .filter((b): b is { name: string } & Extract<BudgetRead, { found: true }> => b !== undefined)
  const suffix = slots === undefined ? '' : ` · slots ${slots.held}/${slots.cap}`
  if (found.length === 0) return `Account usage: no budget reading available from any row.${suffix}`

  const freshest = found.reduce((a, b) => (b.age_seconds < a.age_seconds ? b : a))
  const windows = Object.entries(freshest.budget.rate_limits).map(
    ([name, w]) => `${name} ${round(w.used_pct)}%`,
  )
  const usage = windows.length > 0 ? windows.join(', ') : 'no account rate-limit windows in the payload'
  return `Account usage (from ${freshest.name}'s reading, ${freshest.age_seconds}s old): ${usage}.${suffix}`
}

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
    .map(name => readBudget(name.slice(0, -'.json'.length), now, dir))
    .filter((read): read is Extract<BudgetRead, { found: true }> => read.found)
  if (reads.length === 0) return { found: false, path: cache, reason: 'no_file' }
  return reads.reduce((a, b) => (b.budget.written_at > a.budget.written_at ? b : a))
}
