import type { DeliveredMessage, EventKind, QueueItem } from '../protocol.js'

/**
 * The storage seam. Everything downstream of the broker depends on this
 * interface, never on the sqlite-backed `EventLog` that implements it today —
 * so re-hosting the log behind a service is a matter of adding a second
 * implementation, not of chasing `node:sqlite` through the call graph.
 */

export interface AppendInput {
  kind: EventKind
  actor: string
  target?: string
  msgId?: string
  ref?: string
  body?: string
  meta?: Record<string, string>
}

/**
 * A log row in the shape the agent fold consumes: decoded `meta`, camelCase, and
 * no `id`. Deliberately not the sqlite `Row` — nothing downstream of the fold
 * should depend on the storage schema.
 */
export interface AgentEventRow {
  kind: EventKind
  ts: number
  actor: string
  target: string | null
  msgId: string | null
  ref: string | null
  body: string | null
  meta: Record<string, string>
}

export interface EventStore {
  append(input: AppendInput): { id: number; msgId: string }

  /** Everything addressed to `name`, oldest first. */
  inboxFor(name: string, limit: number): DeliveredMessage[]

  /** Everything one session did or had done to it, newest last. */
  activityFor(name: string, limit: number): QueueItem[]

  /** Open items for the human: addressed to them and not yet answered or dismissed. */
  humanQueue(): QueueItem[]

  /** How many items of one kind this session has outstanding, for budgeting. */
  openCount(actor: string, kind: EventKind): number

  /** Same budget, but by durable agent identity rather than by name. */
  openCountByAgent(agentId: string, kind: EventKind): number

  /** The stored text of a still-open endorsement request, with composer and recipient. */
  openEndorsement(msgId: string): { composer: string; recipient: string; text: string } | undefined

  /** The questions this session still has outstanding, not just how many. */
  openQuestions(actor: string): QueueItem[]

  /** Peer traffic that landed in `name`'s inbox since `since`. */
  inboxCountSince(name: string, since: number): number

  /** The session that raised `msgId`, so an answer knows where to go back to. */
  authorOf(msgId: string): string | undefined

  isOpen(msgId: string): boolean

  /** Every row that bears on an agent identity, oldest first. */
  agentEvents(): AgentEventRow[]

  history(limit: number): QueueItem[]

  close(): void
}
