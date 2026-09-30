import type { DeliveredMessage } from '../protocol.js'
import type { EventStore } from './event-store.js'

/**
 * The dark-seat hold (CC-320): a message to a seat with no active session is kept
 * in its inbox and pushed when it registers, instead of failing to route.
 */

/** The most messages kept for one dark episode; the next send is refused, so its sender knows. */
export const SEAT_HOLD_MAX = 50

/** A seat dark for longer takes no new holds, and a held message older than this is left to chat_inbox. */
export const SEAT_HOLD_MAX_AGE_MS = 24 * 3_600_000

/** `meta.held` on a message row the hold wrote. */
export const SEAT_HOLD_MARK = 'seat_dark'

export type HoldVerdict = { hold: true } | { hold: false; reason: string }

/** Undefined when `name` has no dark episode on record, which leaves the send to fail as it always has. */
export function holdVerdict(events: EventStore, name: string, now: number): HoldVerdict | undefined {
  const dark = events.darkSince(name)
  if (dark === undefined) return undefined
  if (now - dark.at > SEAT_HOLD_MAX_AGE_MS)
    return {
      hold: false,
      reason: `no active session named "${name}", and it has been dark too long to hold messages for`,
    }
  if (events.inboxSince(name, dark.id, SEAT_HOLD_MAX).length >= SEAT_HOLD_MAX)
    return {
      hold: false,
      reason: `no active session named "${name}", and its hold is full (${SEAT_HOLD_MAX} messages)`,
    }
  return { hold: true }
}

/** What to push to a seat registering out of the dark episode that began at log id `darkId`: oldest first. */
export function heldMessages(
  events: EventStore,
  name: string,
  darkId: number,
  now: number,
): DeliveredMessage[] {
  return events
    .inboxSince(name, darkId, SEAT_HOLD_MAX)
    .filter(message => now - message.at <= SEAT_HOLD_MAX_AGE_MS)
    .map(({ id: _id, ...message }) => message)
}
