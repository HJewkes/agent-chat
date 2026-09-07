import fs from 'node:fs'
import path from 'node:path'
import { configDir } from './transcript.js'

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

export const budgetDir = (): string =>
  process.env.AGENT_CHAT_STATUS_CACHE ?? path.join(configDir(), 'status-cache', 'sessions')

/**
 * A session id reaches us from the registry, which got it from a peer's
 * environment — not from a model. It is a uuid in every case observed, but it
 * is still a string arriving from another process and it is about to become a
 * path segment, so it is constrained here rather than trusted.
 */
export const budgetPath = (sessionId: string): string =>
  path.join(budgetDir(), `${safeSessionId(sessionId)}.json`)

const SESSION_ID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/

function safeSessionId(sessionId: string): string {
  if (!SESSION_ID_SHAPE.test(sessionId)) throw new Error(`unusable session id: ${sessionId}`)
  return sessionId
}

export function readBudget(sessionId: string, now = Date.now()): BudgetRead {
  let file: string
  try {
    file = budgetPath(sessionId)
  } catch {
    return { found: false, path: budgetDir(), reason: 'malformed' }
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
  }
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
