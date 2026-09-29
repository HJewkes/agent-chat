/**
 * GitHub's secondary (content-creation) limit answers 403 with one of two
 * messages. "secondary rate limit" is unambiguous. "API rate limit exceeded"
 * is also what the primary limit says, so it only counts as secondary once the
 * core quota is known to have room left; `ambiguous` asks the caller to check.
 */
export type FailureKind = 'secondary' | 'ambiguous' | 'other'

export function classifyFailure(output: string): FailureKind {
  const text = output.toLowerCase()
  if (text.includes('secondary rate limit')) return 'secondary'
  if (text.includes('api rate limit exceeded')) return 'ambiguous'
  return 'other'
}

/** Seconds from a `Retry-After` header, when gh printed one (it does under `gh api -i`). */
export function parseRetryAfter(output: string): number | undefined {
  const match = /^retry-after:\s*(\d+)\s*$/im.exec(output)
  return match ? Number(match[1]) : undefined
}

export const BACKOFF_MS = [60_000, 120_000, 300_000] as const

export const MAX_RETRY_AFTER_MS = 300_000

/** How long to wait before retry number `attempt + 1`, or undefined to give up. */
export function backoffDelay(attempt: number, retryAfterSeconds: number | undefined): number | undefined {
  if (attempt >= BACKOFF_MS.length) return undefined
  if (retryAfterSeconds === undefined) return BACKOFF_MS[attempt]
  return Math.min(retryAfterSeconds * 1000, MAX_RETRY_AFTER_MS)
}
