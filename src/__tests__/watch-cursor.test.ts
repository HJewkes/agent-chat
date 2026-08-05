import { describe, expect, it } from 'vitest'
import { nextWatchCursor } from '../broker/watch-cursor.js'

/**
 * CC-73. Every case here is a way to lose or repeat a message, and the losing
 * ones are the point: a watcher that skips a row shows nothing, which is
 * indistinguishable from an inbox that is simply quiet.
 */
describe('nextWatchCursor', () => {
  it('advances to the head when the inbox was empty', () => {
    // Without this a quiet inbox re-scans the same range on every poll and the
    // cursor never moves off where the watcher armed.
    expect(nextWatchCursor({ head: 900, lastReturned: 0, truncated: false })).toBe(900)
  })

  it('advances to the head when the read was complete', () => {
    expect(nextWatchCursor({ head: 900, lastReturned: 880, truncated: false })).toBe(900)
  })

  it('stops at the last row returned when the read was truncated', () => {
    // The rows between 500 and the head have NOT been shown yet. Skipping to
    // 900 here is the message-losing bug this rule exists to prevent.
    expect(nextWatchCursor({ head: 900, lastReturned: 500, truncated: true })).toBe(500)
  })

  it('clears a row that landed after the head was read', () => {
    // The head is sampled before the query, so a row arriving in between is
    // returned while sitting above it. Resuming at the head would show it twice.
    expect(nextWatchCursor({ head: 900, lastReturned: 903, truncated: false })).toBe(903)
  })

  it('never goes backwards on a complete read', () => {
    expect(nextWatchCursor({ head: 0, lastReturned: 42, truncated: false })).toBe(42)
  })

  it('is idempotent for a poll that found nothing on an empty log', () => {
    expect(nextWatchCursor({ head: 0, lastReturned: 0, truncated: false })).toBe(0)
  })
})
