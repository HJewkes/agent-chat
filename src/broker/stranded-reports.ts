import type { DeliveredMessage } from '../protocol.js'
import { SEAT_HOLD_MAX_AGE_MS } from './seat-hold.js'

/**
 * CC-321, bounded by CC-337: reports a connection closed on before they were
 * pushed, kept by name for the next connection to take it. Every one is already
 * in the log, so one dropped here is a missed wake and stays in `chat_inbox`.
 */

/** A report stranded longer than a seat's dark hold (CC-320) is left to `chat_inbox`. */
export const STRANDED_MAX_AGE_MS = SEAT_HOLD_MAX_AGE_MS

/** The most reports kept for one name; the oldest go first, as CC-320 keeps a seat's hold. */
export const STRANDED_MAX_PER_NAME = 50

/** The most names kept at once; the name stranded on longest ago goes first. */
export const STRANDED_MAX_NAMES = 256

interface Stranded {
  message: DeliveredMessage
  at: number
}

export class StrandedReports {
  private readonly byName = new Map<string, Stranded[]>()

  add(name: string, messages: readonly DeliveredMessage[], now: number): void {
    if (messages.length === 0) return
    const kept = this.byName.get(name) ?? []
    // Re-inserted so the map's order is the order names were last stranded on.
    this.byName.delete(name)
    this.byName.set(
      name,
      [...kept, ...messages.map(message => ({ message, at: now }))].slice(-STRANDED_MAX_PER_NAME),
    )
    if (this.byName.size <= STRANDED_MAX_NAMES) return
    const [oldest] = this.byName.keys()
    if (oldest !== undefined) this.byName.delete(oldest)
  }

  /** What `name` closed on and is still young enough to push, removed either way. */
  take(name: string, now: number): DeliveredMessage[] {
    const kept = this.byName.get(name) ?? []
    this.byName.delete(name)
    return kept.filter(s => now - s.at <= STRANDED_MAX_AGE_MS).map(s => s.message)
  }
}
