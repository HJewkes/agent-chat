import type { CursoredMessage, DeliveredMessage, EventKind, QueueItem } from '../protocol.js'

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

/**
 * An `AgentEventRow` with the log id that ordered it.
 *
 * The id is deliberately absent from `AgentEventRow` — the agent fold is a pure
 * function over content and has no business knowing storage order. The SSE tail
 * is the opposite case: there the id IS the contract, because it becomes the
 * frame's `id:` and therefore the browser's resume cursor.
 */
export interface LoggedEventRow extends AgentEventRow {
  id: number
}

export interface EventStore {
  append(input: AppendInput): { id: number; msgId: string }

  /** Everything addressed to `name`, oldest first. */
  inboxFor(name: string, limit: number): DeliveredMessage[]

  /**
   * The same inbox, but only what landed after `afterId`, oldest first.
   *
   * The read a watcher resumes from (CC-73). `inboxFor` cannot serve it: a
   * poller needs to know which rows are NEW since it last looked, and a
   * newest-N window answers a different question — it re-reports what was
   * already seen and silently drops anything that arrived faster than N.
   */
  inboxSince(name: string, afterId: number, limit: number): CursoredMessage[]

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

  /**
   * Rows with `id > afterId`, oldest first, at most `limit` of them.
   *
   * The one read the SSE tail needs. A reconnecting browser sends back the last
   * frame id it saw and this returns exactly what it missed, in the order it was
   * written. Bounded on purpose: an unbounded replay is how a browser left open
   * overnight ends up re-reading the whole log in one burst.
   */
  since(afterId: number, limit: number): LoggedEventRow[]

  /** The highest id in the log, or 0 when it is empty. */
  latestId(): number

  close(): void
}
