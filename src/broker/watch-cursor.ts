/**
 * Where a watcher resumes after one `inbox_since` read (CC-73).
 *
 * Pure, and deliberately its own module rather than four lines inside the
 * socket switch: getting this wrong loses messages SILENTLY, which is the exact
 * failure the watch command exists to end, and a rule that can only be
 * exercised through a live broker is a rule that will not be exercised.
 */

export interface CursorInput {
  /** The log head, read BEFORE the rows — see the caller for why the order matters. */
  head: number
  /** The highest id actually returned, or 0 when the read was empty. */
  lastReturned: number
  /** True when `limit` cut the read short, so known backlog remains. */
  truncated: boolean
}

export function nextWatchCursor({ head, lastReturned, truncated }: CursorInput): number {
  // A truncated read has rows behind it that were not returned. Skipping to the
  // head here would step over every one of them.
  if (truncated) return lastReturned
  // A complete read may skip to the head, and must: otherwise a quiet inbox
  // re-scans the same range on every poll and the cursor never moves.
  //
  // The max() covers the one race the caller cannot close — a row landing
  // between the head read and the query is RETURNED by the query while sitting
  // above `head`, so resuming at `head` alone would show it again next poll.
  return Math.max(head, lastReturned)
}
