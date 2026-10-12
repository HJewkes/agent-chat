import type { EventStore } from './event-store.js'

/**
 * CC-397: how long a teleporting name's claims wait for its successor. A successor
 * that has not attached in ten minutes is not coming; teleport's own relaunch retry
 * is well inside this.
 */
export const TELEPORT_GAP_MS = 10 * 60_000

/**
 * Whether `name` is between a committed teleport and its successor attaching: it
 * wrote a handoff, stood down, and no successor has taken the identity yet.
 */
export function midTeleport(events: EventStore, name: string, now: number): boolean {
  return events.undeliveredHandoffs(now - TELEPORT_GAP_MS).some(handoff => handoff.name === name)
}
