import { SUBSCRIBABLE_KINDS, type SubscribableKind, type SystemEvent } from '../protocol.js'
import type { Registry } from './registry.js'

/**
 * Lifecycle events, pushed to the sessions that asked for them.
 *
 * This is a FILTER over rows the log already writes, not a new event source.
 * Subscriptions add no EventKind, because that union is frozen into the SSE
 * contract; everything here selects from what `append` already produced.
 */

/**
 * Three agents starting together is one thing that happened, not three
 * interruptions. Peer traffic already lengthens turns (CC-16), and a join feed
 * that pushed per-row would make that worse for no added information.
 */
const COALESCE_MS = 250

const isSubscribable = (kind: string): kind is SubscribableKind =>
  (SUBSCRIBABLE_KINDS as readonly string[]).includes(kind)

/**
 * Target-then-actor. `agent_spawned` names the agent in `target` while
 * `agent_exited` carries only `actor`, and a subscriber cares about the agent
 * either way.
 */
const subjectOf = (row: { actor?: string; target?: string }): string | undefined => row.target ?? row.actor

export class SystemEventFeed<C> {
  private readonly pending = new Map<C, SystemEvent[]>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly registry: Registry<C>,
    private readonly push: (conn: C, events: SystemEvent[]) => void,
    private readonly coalesceMs: number = COALESCE_MS,
  ) {}

  offer(row: { kind: string; actor?: string; target?: string; body?: string }): void {
    if (!isSubscribable(row.kind)) return
    const subject = subjectOf(row)
    if (subject === undefined) return

    const recipients = this.registry.subscribersFor({ kind: row.kind, subject })
    if (recipients.length === 0) return

    const event: SystemEvent = {
      kind: row.kind,
      subject,
      at: Date.now(),
      ...(row.body ? { detail: row.body } : {}),
    }
    for (const conn of recipients) {
      const queued = this.pending.get(conn)
      if (queued) queued.push(event)
      else this.pending.set(conn, [event])
    }
    // Unref'd: a pending join notification must never be the reason the broker
    // stays alive, and the log has the row regardless of whether this fires.
    if (this.timer === null) this.timer = setTimeout(() => this.flush(), this.coalesceMs).unref()
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    for (const [conn, events] of this.pending) this.push(conn, events)
    this.pending.clear()
  }

  close(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
  }
}
