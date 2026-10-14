import { holdClass, type ReviewSlots, type ShepherdRow } from '../../shepherd-client.js'

/**
 * CC-1106: how many reviews wait on Shepherd's review capacity, the input to burndown's review backpressure.
 * The one derivation of "reviews in flight": the limits report (CC-1102) imports it rather than counting its own.
 */
export type ReviewBacklog =
  { queued: number; waiting: number; running: number; cap: number } | { unknown: string }

/** A hold of this class waits on a review account's headroom, so the review still waits on review capacity. */
const CAPACITY_HOLD = 'account-exhausted'

/**
 * `waiting` counts `review` rows that are unheld or held for account headroom; any other hold (an owner, a g10
 * gate) is not waiting on review capacity. An unread roster takes every slot as busy, `min(waiting, cap)`, the
 * smallest queue the rows allow, so an unread roster never holds the line on its own.
 */
export function reviewBacklog(rows: readonly ShepherdRow[], slots: ReviewSlots | undefined): ReviewBacklog {
  if (slots === undefined) return { unknown: 'shepherd status carried no reviewSlots' }
  const waiting = rows.filter(isWaitingOnReview).length
  const running = slots.running?.length ?? Math.min(waiting, slots.cap)
  return { queued: Math.max(0, waiting - running), waiting, running, cap: slots.cap }
}

function isWaitingOnReview(row: ShepherdRow): boolean {
  return row.phase === 'review' && (row.held == null || holdClass(row) === CAPACITY_HOLD)
}
