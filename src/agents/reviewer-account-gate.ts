import { MAX_ACCOUNT_READING_AGE_SECONDS } from './budget.js'

/**
 * CC-1078: a reviewer spawned into an account past its five_hour limit burns a session and ends
 * with no verdict. The broker refuses it up front, retryably, and names the reset so Shepherd can
 * back off to it rather than spawn again at the same head.
 */
export const REVIEWER_ACCOUNT_LIMIT = 'reviewer_account_limit'

/** The ceiling of an account no charter pool names: the account's own hard limit. */
export const DEFAULT_REVIEWER_CEILING = 100

/** The billed account's five_hour window, as epoch ms rather than the status line's seconds. */
export interface ReviewerAccountWindow {
  usedPct: number
  resetsAtMs?: number
  ageSeconds: number
}

/** What the gate judges. `window` is absent when the account has no five_hour reading, and `miss` says why. */
export interface ReviewerAccountRead {
  configDir: string
  window?: ReviewerAccountWindow
  miss?: string
  ceiling: number
  /** The charter pool the ceiling came from; absent means the default. */
  pool?: string
}

export interface ReviewerAccountVerdict {
  allow: boolean
  reason: string
  resetsAt?: number
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Oct 12 at 12:30am (UTC)", the shape Shepherd's `parseLimitReset` reads. Always UTC, so it is deterministic. */
export function resetWords(epochMs: number): string {
  const at = new Date(epochMs)
  const hour = at.getUTCHours()
  const minute = String(at.getUTCMinutes()).padStart(2, '0')
  const clock = `${hour % 12 === 0 ? 12 : hour % 12}:${minute}${hour < 12 ? 'am' : 'pm'}`
  return `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()} at ${clock} (UTC)`
}

const resetTail = (resetsAtMs: number | undefined): string =>
  resetsAtMs === undefined
    ? 'reset time not reported'
    : `resets ${resetWords(resetsAtMs)} [${new Date(resetsAtMs).toISOString()}]`

/**
 * Usage in a window only rises until its reset, so a reading with a future reset is trusted however
 * old it is. One with no reset time is trusted only while it is fresh.
 */
function untrusted(window: ReviewerAccountWindow, now: number): string | undefined {
  if (window.resetsAtMs !== undefined)
    return window.resetsAtMs <= now
      ? `five_hour window reset at ${new Date(window.resetsAtMs).toISOString()}`
      : undefined
  if (window.ageSeconds > MAX_ACCOUNT_READING_AGE_SECONDS)
    return `five_hour reading is stale (${window.ageSeconds}s old, no reset time)`
  return undefined
}

/** Fails open: a missing, reset or stale reading lets the spawn through, and the reason says which. */
export function reviewerAccountGate(read: ReviewerAccountRead, now: number): ReviewerAccountVerdict {
  const { window, ceiling } = read
  if (window === undefined) return { allow: true, reason: `no five_hour reading: ${read.miss ?? 'none'}` }
  const skip = untrusted(window, now)
  if (skip !== undefined) return { allow: true, reason: skip }
  if (window.usedPct < ceiling)
    return { allow: true, reason: `five_hour ${window.usedPct}% under ceiling ${ceiling}%` }
  const source = read.pool ?? 'no charter pool'
  const reason =
    `reviewer account limit: account ${read.configDir} five_hour ${window.usedPct}% at or over ` +
    `ceiling ${ceiling}% (${source}); ${resetTail(window.resetsAtMs)}`
  return { allow: false, reason, ...(window.resetsAtMs === undefined ? {} : { resetsAt: window.resetsAtMs }) }
}
