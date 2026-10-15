import { SUBSCRIBABLE_KINDS, type SubscribableKind, type SystemEvent } from '../protocol.js'
import { logEvent } from './log.js'
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

/**
 * CC-321: the one session, by name, that already holds an exit's report and is not told now.
 * `deferred` (CC-337): its report is still held, so the verdict comes later, once it is written.
 */
export interface ExitJudgement {
  spawner: string
  deferred: boolean
}

type ExitJudge = (
  agentId: string | undefined,
  exit: Record<string, string> | undefined,
  later: (spawner: string, muted: boolean) => void,
) => ExitJudgement | undefined

type Offered = {
  kind: string
  actor?: string
  target?: string
  ref?: string
  body?: string
  meta?: Record<string, string>
}

export class SystemEventFeed<C> {
  private readonly pending = new Map<C, SystemEvent[]>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly registry: Registry<C>,
    private readonly push: (conn: C, events: SystemEvent[]) => void,
    private readonly coalesceMs: number = COALESCE_MS,
    private readonly reportedTo: ExitJudge = () => undefined,
  ) {}

  offer(row: Offered): void {
    if (!isSubscribable(row.kind)) return
    // An adopted identity is minted the moment an ordinary session registers, and
    // that same event already goes out as `registered`. Pushing both would mean a
    // subscriber's feed doubled up on the day sessions gained identities, for no
    // information it did not already have. The row is in the log either way.
    if (row.kind === 'agent_spawned' && row.meta?.origin === 'adopted') return
    const subject = subjectOf(row)
    if (subject === undefined) return

    const event: SystemEvent = {
      kind: row.kind,
      subject,
      at: Date.now(),
      ...(row.body ? { detail: row.body } : {}),
    }
    const reported =
      row.kind === 'agent_exited'
        ? this.reportedTo(row.ref, row.meta, (spawner, muted) => this.settle(event, spawner, row.ref, muted))
        : undefined
    const recipients = this.registry
      .subscribersFor({ kind: row.kind, subject })
      .filter(conn => !this.alreadyReported(conn, reported, row.ref))
    this.queue(recipients, event)
  }

  private queue(recipients: readonly C[], event: SystemEvent): void {
    if (recipients.length === 0) return
    for (const conn of recipients) {
      const queued = this.pending.get(conn)
      if (queued) queued.push(event)
      else this.pending.set(conn, [event])
    }
    // Unref'd: a pending join notification must never be the reason the broker
    // stays alive, and the log has the row regardless of whether this fires.
    if (this.timer === null) this.timer = setTimeout(() => this.flush(), this.coalesceMs).unref()
  }

  /** Only the push is skipped: the `agent_exited` row is in the log and on the roster either way. */
  private alreadyReported(
    conn: C,
    reported: ExitJudgement | undefined,
    agentId: string | undefined,
  ): boolean {
    if (reported === undefined || this.registry.nameOf(conn) !== reported.spawner) return false
    logEvent(reported.deferred ? 'exit_notice_deferred' : 'exit_notice_suppressed', {
      agentId,
      spawner: reported.spawner,
    })
    return true
  }

  /** CC-337: the spawner's held report is written; tell it of the exit unless that report closed the run. */
  private settle(event: SystemEvent, spawner: string, agentId: string | undefined, muted: boolean): void {
    if (muted) return void logEvent('exit_notice_suppressed', { agentId, spawner })
    const recipients = this.registry
      .subscribersFor({ kind: event.kind, subject: event.subject })
      .filter(conn => this.registry.nameOf(conn) === spawner)
    this.queue(recipients, event)
  }

  /** A subscriber that disconnected mid-window is simply dropped, not pushed to. */
  forget(conn: C): void {
    this.pending.delete(conn)
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    for (const [conn, events] of this.pending) {
      // A conn can close inside the coalesce window, and writing to a closed
      // socket throws. One dead subscriber must not cost every other subscriber
      // its notification, so the failure is contained per recipient rather than
      // allowed to abandon the loop.
      try {
        this.push(conn, events)
      } catch {
        // Nothing to recover: the rows are durable in the log regardless.
      }
    }
    this.pending.clear()
  }

  close(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
  }
}
