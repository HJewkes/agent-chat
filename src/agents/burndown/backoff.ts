import type { Ledger, ReleaseRecord } from './ledger.js'

/**
 * Release backoff (CC-661). Each release of a task doubles how long the tick
 * waits before handing it out again, so a task that keeps stalling stops
 * eating lanes. The doubling caps at the fifth release (16x base).
 */

export const RELEASE_BASE_MS = 15 * 60_000

const MAX_DOUBLINGS = 4

export interface Hold {
  n: number
  until: Date
}

/** Epoch ms at which a task released `rec.n` times, last at `rec.at`, may be dispatched again. */
export function heldUntil(rec: ReleaseRecord, base = RELEASE_BASE_MS): number {
  const doublings = Math.min(Math.max(rec.n, 1) - 1, MAX_DOUBLINGS)
  return Date.parse(rec.at) + base * 2 ** doublings
}

/** Tasks still inside their release hold at `now`, keyed by task id. */
export function backoffHeld(ledger: Ledger, now: Date, base = RELEASE_BASE_MS): Map<string, Hold> {
  const held = new Map<string, Hold>()
  for (const [taskId, rec] of Object.entries(ledger.releases ?? {})) {
    const until = heldUntil(rec, base)
    if (now.getTime() < until) held.set(taskId, { n: rec.n, until: new Date(until) })
  }
  return held
}
