import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { home } from '../paths.js'
import type {
  DecidedItem,
  DecisionBasis,
  DeliveredMessage,
  EventKind,
  Provenance,
  QueueItem,
} from '../protocol.js'
import { wakeSource, type CursoredMessage, type DecisionCitation } from '../protocol.js'
import { resolveNoticeTtlMs } from '../config.js'
import { DECISION_AUDIT_MS, decidedText, overruleText } from './decisions.js'
import { undeliveredHandoffs, type StoredHandoff } from './handoffs.js'
import { NOTICE_LIVE } from './notice-expiry.js'
import type {
  AgentEventRow,
  AppendInput,
  Decision,
  EventStore,
  LoggedEventRow,
  OpenApproval,
  OpenEndorsement,
} from './event-store.js'

/**
 * Append-only event log. Everything that happens on the bus lands here; live
 * delivery is a side effect, not the record. Derived state (a session's inbox,
 * the human queue) is a query, never a stored aggregate — which is why the
 * inbox now survives a broker restart and why "resolved" is itself an event.
 *
 * The sqlite-backed implementation of `EventStore`. With the ledger shim
 * (`agents/ledger/db-shim.ts`), one of two files that know `node:sqlite` exists.
 */

export type {
  AgentEventRow,
  AppendInput,
  Decision,
  EventStore,
  LoggedEventRow,
  OpenApproval,
  OpenEndorsement,
} from './event-store.js'

/** The question's columns, aliased beside a `decided` row in `decidedQueue`. */
interface QuestionColumns {
  q_msg_id: string
  q_actor: string
  q_body: string | null
  q_ts: number
  q_meta: string | null
}

interface Row {
  id: number
  ts: number
  kind: string
  actor: string
  target: string | null
  msg_id: string | null
  ref: string | null
  body: string | null
  meta: string | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,
  kind   TEXT    NOT NULL,
  actor  TEXT    NOT NULL,
  target TEXT,
  msg_id TEXT,
  ref    TEXT,
  body   TEXT,
  meta   TEXT
);
CREATE INDEX IF NOT EXISTS events_target ON events(target, id);
CREATE INDEX IF NOT EXISTS events_msg_id ON events(msg_id);
CREATE INDEX IF NOT EXISTS events_ref ON events(ref);
CREATE INDEX IF NOT EXISTS events_kind ON events(kind, id);
`

/** Kinds that a recipient should see in their inbox. */
const INBOX_KINDS = ["'message'", "'broadcast'", "'answer'", "'decided'"].join(',')
/** Kinds that need the human to look at them. */
const QUEUE_KINDS = ["'message'", "'question'", "'notice'", "'approval_request'", "'endorse_request'"].join(
  ',',
)
/**
 * The local terminal dialog stays open in parallel and the first verdict wins,
 * but Claude Code sends no event when it does. A pending approval is therefore
 * presumed answered after this long rather than lingering in the queue forever.
 */
export const APPROVAL_TTL_MS = 10 * 60 * 1000

/**
 * Hook-raised approvals (CC-144) are exempt from the TTL: the hook is still blocking
 * while the row is open, and the broker closes the row itself when the hook withdraws or
 * disconnects, so age says nothing about whether anyone is waiting.
 */
const AGES_OUT = `(kind != 'approval_request' OR ts > ? OR json_extract(meta, '$.source') = 'hook')`

/** An item is closed once something references it as answered or dismissed. */
const CLOSED = `SELECT ref FROM events WHERE kind IN ('answer','resolution') AND ref IS NOT NULL`

/**
 * Questions the decider answered. Still open to the human, who may overrule,
 * but answered as far as the asker and the "needs an answer" queue are concerned.
 */
const DECIDED = `SELECT ref FROM events WHERE kind = 'decided' AND ref IS NOT NULL`

/**
 * Kinds the agent read model folds over. `agent_spawn_refused` and
 * `verdict_refused` are absent on purpose: a refusal never creates or advances
 * an identity, so folding it would invent an agent that was never spawned.
 */
const AGENT_KINDS = [
  'agent_spawned',
  'agent_attached',
  'agent_detached',
  'agent_resumed',
  'agent_exited',
  'agent_retired',
  'agent_handoff',
  'agent_stood_down',
  'isolation_allocated',
  'isolation_released',
  'isolation_parked',
] as const satisfies readonly EventKind[]

const AGENT_KINDS_SQL = AGENT_KINDS.map(k => `'${k}'`).join(',')

/** A return-contract report: `Status:` or a reviewer's `Verdict:`, after any markdown decoration (CC-266). */
const REPORT_OPENING = /^[\s*_`#>]*(status|verdict)[*_`]*\s*:/i

export type ReportKind = 'status' | 'verdict'

/** Which return-contract report a message opens as, if any (CC-763). */
export const reportKindOf = (text: string): ReportKind | undefined =>
  REPORT_OPENING.exec(text)?.[1]?.toLowerCase() as ReportKind | undefined

/** Whether a message opens as a return-contract report; the one test CC-266 and CC-321 share. */
export const isReport = (text: string): boolean => reportKindOf(text) !== undefined

/** A report that says the sender is finished: a closing return-contract status, or any `Verdict:` (CC-321). */
const TERMINAL_OPENING =
  /^[\s*_`#>]*(verdict[*_`]*\s*:|status[*_`]*\s*:[\s*_`]*(done|done_with_concerns|blocked|needs_context)\b)/i

/** Whether a message is its sender's last word; `Status: IN PROGRESS` is a report and is not this. */
export const isTerminalReport = (text: string): boolean => TERMINAL_OPENING.test(text)

// Loaded through require so Vite/vitest don't try to pre-bundle a builtin they
// don't yet know about. The type import above is erased, so it costs nothing.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { timeout?: number }) => DatabaseSyncType
}

export const BUSY_TIMEOUT_MS = 5_000

export const newMsgId = (): string => randomUUID().slice(0, 8)

const citationOf = (meta: Record<string, string>): DecisionCitation => ({
  precedent: meta.precedent ?? '',
  class: meta.class ?? '',
  basis: (meta.basis ?? '') as DecisionBasis,
  reversible: meta.reversible ?? '',
})

/** Replays rebuild the same text the live push carried, so an inbox read matches the channel. */
function messageText(row: Row, meta: Record<string, string>): string {
  const body = row.body ?? ''
  if (row.kind === 'decided') return decidedText(body, row.actor, citationOf(meta))
  if (row.kind === 'answer' && meta.overrules) return overruleText(body, meta)
  return body
}

const toMessage = (row: Row): DeliveredMessage => {
  const meta = (row.meta ? JSON.parse(row.meta) : {}) as Record<string, string>
  const decided = row.kind === 'decided'
  const woken = row.kind === 'message' ? wakeSource(meta.source) : undefined
  return {
    msgId: row.msg_id ?? String(row.id),
    from: row.actor,
    text: messageText(row, meta),
    at: row.ts,
    ...(row.ref ? { inReplyTo: row.ref } : {}),
    ...(row.kind === 'broadcast' ? { broadcast: true } : {}),
    ...(meta.event ? { event: meta.event } : {}),
    ...(woken === undefined ? {} : { wakeSource: woken }),
    // Replayed from the row the broker wrote, so a message re-read from the
    // inbox carries the same marker the live push did. Nothing a client sends
    // reaches `meta`, which is what keeps this as trustworthy on the way out as
    // it was on the way in.
    ...(meta.provenance === 'human-endorsed' ? { provenance: 'human-endorsed' as Provenance } : {}),
    // From the kind rather than `meta`: only `BrokerCore.decide` writes this kind.
    ...(decided ? { provenance: 'decided' as Provenance, event: 'decided' } : {}),
  }
}

const toQueueItem = (row: Row): QueueItem => ({
  msgId: row.msg_id ?? String(row.id),
  kind: row.kind as QueueItem['kind'],
  from: row.actor,
  text: row.body ?? '',
  at: row.ts,
  meta: (row.meta ? JSON.parse(row.meta) : {}) as Record<string, string>,
})

const toAgentEventRow = (row: Row): AgentEventRow => ({
  kind: row.kind as EventKind,
  ts: row.ts,
  actor: row.actor,
  target: row.target,
  msgId: row.msg_id,
  ref: row.ref,
  body: row.body,
  meta: (row.meta ? JSON.parse(row.meta) : {}) as Record<string, string>,
})

/**
 * 0600 on the log and its WAL sidecars, for the same reason `token.ts` and
 * `launch-files.ts` already do it: this file holds every brief verbatim
 * (`supervisor.ts` appends `body: req.brief` on `agent_spawned`), and briefs are
 * routinely somebody else's text — relay dispatches task bodies its operator
 * captured by voice. Left at the default it was `-rw-r--r--`, readable by any
 * local account, which is a durable version of exactly the `ps` disclosure that
 * relay's R-68 went to some trouble to close.
 *
 * SQLite creates `-wal` and `-shm` itself, after and independently of the main
 * file, so all three are named rather than trusting the first to cover them.
 * Missing sidecars are not an error: WAL mode creates them lazily, and a
 * read-only or freshly-created log may legitimately have none yet.
 *
 * The DIRECTORY is what actually holds the line, and is why this does not stop
 * at the three files. SQLite deletes the sidecars on a clean close and recreates
 * them on the next open — under the process umask, not under whatever this last
 * set them to. A 0700 directory makes them unreachable no matter what mode they
 * come back with; the per-file chmod is what fixes logs that already exist.
 */
function restrictToOwner(file: string): void {
  for (const path of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      fs.chmodSync(path, 0o600)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
  fs.chmodSync(path.dirname(file), 0o700)
}

export class EventLog implements EventStore {
  private readonly db: DatabaseSyncType
  private readonly noticeTtlMs: () => number
  /** The newest log id when this log was opened, and when: for the broker, its boot. */
  private readonly opened: { id: number; at: number }

  constructor(dbPath?: string, options: { noticeTtlMs?: () => number } = {}) {
    this.noticeTtlMs = options.noticeTtlMs ?? resolveNoticeTtlMs
    const file = dbPath ?? path.join(home(), 'events.db')
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    // Another process's write lock (a CLI, or a broker losing the boot race) is waited out, not thrown.
    this.db = new DatabaseSync(file, { timeout: BUSY_TIMEOUT_MS })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
    restrictToOwner(file)
    const last = this.db.prepare('SELECT MAX(id) AS id FROM events').get() as { id: number | null }
    this.opened = { id: last.id ?? 0, at: Date.now() }
  }

  /** CC-118: the lifecycle ledger's tables share this connection, so shadow writes never meet `SQLITE_BUSY`. */
  ledgerHandle(): DatabaseSyncType {
    return this.db
  }

  append(input: AppendInput): { id: number; msgId: string } {
    const msgId = input.msgId ?? newMsgId()
    const stmt = this.db.prepare(
      `INSERT INTO events (ts, kind, actor, target, msg_id, ref, body, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const result = stmt.run(
      Date.now(),
      input.kind,
      input.actor,
      input.target ?? null,
      msgId,
      input.ref ?? null,
      input.body ?? null,
      input.meta ? JSON.stringify(input.meta) : null,
    )
    return { id: Number(result.lastInsertRowid), msgId }
  }

  /** Everything addressed to `name`, oldest first. */
  inboxFor(name: string, limit: number): DeliveredMessage[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM events
           WHERE target = ? AND kind IN (${INBOX_KINDS})
           ORDER BY id DESC LIMIT ?
         ) ORDER BY id ASC`,
      )
      .all(name, limit) as unknown as Row[]
    return rows.map(toMessage)
  }

  /**
   * Position of one of `name`'s own inbox rows by msg_id, for `inbox after`.
   * Scoped to the target so an id from someone else's inbox cannot be probed.
   */
  inboxRowId(name: string, msgId: string): number | undefined {
    const row = this.db
      .prepare(`SELECT id FROM events WHERE target = ? AND kind IN (${INBOX_KINDS}) AND msg_id = ? LIMIT 1`)
      .get(name, msgId) as { id: number } | undefined
    return row?.id
  }

  inboxSince(name: string, afterId: number, limit: number): CursoredMessage[] {
    // Ascending straight out of the query, unlike `inboxFor`: a watcher wants
    // the OLDEST unseen rows, so the limit must cut the far end of a backlog
    // rather than the near end. Index-backed by events_target on (target, id).
    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE target = ? AND kind IN (${INBOX_KINDS}) AND id > ?
         ORDER BY id ASC LIMIT ?`,
      )
      .all(name, afterId, limit) as unknown as Row[]
    return rows.map(row => ({ ...toMessage(row), id: row.id }))
  }

  /**
   * Everything one session did or had done to it, newest last. Read-only and
   * pure query: observing a peer this way puts nothing into that peer's context,
   * which is the whole point — today the only way to learn what a session was
   * doing was to message it, so observation and interruption were the same act.
   */
  activityFor(name: string, limit: number): QueueItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM events
           WHERE actor = ? OR target = ?
           ORDER BY id DESC LIMIT ?
         ) ORDER BY id ASC`,
      )
      .all(name, name, limit) as unknown as Row[]
    return rows.map(row => ({
      msgId: row.msg_id ?? String(row.id),
      kind: row.kind as QueueItem['kind'],
      from: row.actor,
      text: row.body ?? '',
      at: row.ts,
      meta: {
        ...((row.meta ? JSON.parse(row.meta) : {}) as Record<string, string>),
        ...(row.target ? { target: row.target } : {}),
      },
    }))
  }

  lastMessageFrom(from: string, opts: { to?: string; since: number }): QueueItem | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM events
         WHERE actor = ? AND kind = 'message' AND ts >= ? AND (? IS NULL OR target = ?)
         ORDER BY id DESC LIMIT 1`,
      )
      .get(from, opts.since, opts.to ?? null, opts.to ?? null) as unknown as Row | undefined
    if (row === undefined) return undefined
    return {
      msgId: row.msg_id ?? String(row.id),
      kind: 'message',
      from: row.actor,
      text: row.body ?? '',
      at: row.ts,
      meta: row.target ? { target: row.target } : {},
    }
  }

  hasStatusReport(from: string, to: readonly string[], since: number): boolean {
    return this.lastStatusReport(from, to, since) !== undefined
  }

  lastStatusReport(from: string, to: readonly string[], since: number): QueueItem | undefined {
    if (to.length === 0) return undefined
    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE actor = ? AND kind = 'message' AND ts >= ? AND target IN (${to.map(() => '?').join(', ')})
         ORDER BY id DESC`,
      )
      .all(from, since, ...to) as unknown as Row[]
    const row = rows.find(r => isReport(r.body ?? ''))
    if (row === undefined) return undefined
    return {
      msgId: row.msg_id ?? String(row.id),
      kind: 'message',
      from: row.actor,
      text: row.body ?? '',
      at: row.ts,
      meta: row.target ? { target: row.target } : {},
    }
  }

  lastAgentEventAt(ref: string, kind: EventKind): number | undefined {
    const row = this.db
      .prepare(`SELECT ts FROM events WHERE ref = ? AND kind = ? ORDER BY id DESC LIMIT 1`)
      .get(ref, kind) as { ts: number } | undefined
    return row?.ts
  }

  darkSince(name: string): { id: number; at: number } | undefined {
    const row = this.db
      .prepare(
        `SELECT id, ts, kind FROM events
         WHERE actor = ? AND kind IN ('registered', 'deregistered') ORDER BY id DESC LIMIT 1`,
      )
      .get(name) as { id: number; ts: number; kind: string } | undefined
    if (row?.kind === 'deregistered') return { id: row.id, at: row.ts }
    // CC-326: a register from before this log was opened was never closed, so the name is dark since then.
    return row !== undefined && row.id <= this.opened.id ? this.opened : undefined
  }

  /** Open items for the human: addressed to them, not yet answered or dismissed, and not aged out. */
  humanQueue(): QueueItem[] {
    const now = Date.now()
    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE target = 'human' AND kind IN (${QUEUE_KINDS})
           AND msg_id NOT IN (${CLOSED})
           AND msg_id NOT IN (${DECIDED})
           AND ${AGES_OUT}
           AND ${NOTICE_LIVE}
         ORDER BY id ASC`,
      )
      .all(now - APPROVAL_TTL_MS, now - this.noticeTtlMs()) as unknown as Row[]
    return rows.map(row => ({
      msgId: row.msg_id ?? String(row.id),
      kind: row.kind as QueueItem['kind'],
      from: row.actor,
      text: row.body ?? '',
      at: row.ts,
      meta: (row.meta ? JSON.parse(row.meta) : {}) as Record<string, string>,
    }))
  }

  agedOutCandidates(cutoff: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT msg_id FROM events
         WHERE target = 'human' AND kind IN ('message', 'notice') AND ts <= ?
           AND json_extract(meta, '$.kind') IS NULL
           AND msg_id IS NOT NULL AND msg_id NOT IN (${CLOSED})
         ORDER BY id ASC`,
      )
      .all(cutoff) as unknown as { msg_id: string }[]
    return rows.map(row => row.msg_id)
  }

  /** How many items of one kind this session has outstanding, for budgeting. */
  openCount(actor: string, kind: EventKind): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM events
         WHERE actor = ? AND kind = ? AND msg_id NOT IN (${CLOSED}) AND msg_id NOT IN (${DECIDED})`,
      )
      .get(actor, kind) as unknown as { n: number }
    return row.n
  }

  /**
   * Same budget, but by durable agent identity rather than by name (CC-38).
   *
   * `openCount` is keyed on `actor`, which is whatever the composer typed into
   * `chat_register` this connection — a session that re-registers under a new
   * name gets a fresh budget every time. `agent_id` in `meta` is minted by the
   * broker at adoption and cannot be self-asserted, so counting by it closes
   * that for any session with a durable identity. A raw, never-adopted
   * connection has no `agent_id` to key on and falls back to `openCount`.
   */
  openCountByAgent(agentId: string, kind: EventKind): number {
    const rows = this.db
      .prepare(
        `SELECT meta FROM events WHERE kind = ? AND msg_id NOT IN (${CLOSED}) AND msg_id NOT IN (${DECIDED})`,
      )
      .all(kind) as unknown as { meta: string | null }[]
    return rows.filter(row => {
      const meta = (row.meta ? JSON.parse(row.meta) : {}) as Record<string, string>
      return meta.agent_id === agentId
    }).length
  }

  /**
   * The stored text of an endorsement request that is still open, with who
   * composed it and who it was composed for.
   *
   * Delivery reads the body from HERE rather than from the approving request,
   * which is what makes the delivered bytes necessarily the bytes the human was
   * shown. Returns undefined once the item is closed, so an approval is a grant
   * over exactly one message and cannot be replayed.
   */
  openEndorsement(msgId: string): OpenEndorsement | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM events
         WHERE msg_id = ? AND kind = 'endorse_request' AND msg_id NOT IN (${CLOSED}) LIMIT 1`,
      )
      .get(msgId) as unknown as Row | undefined
    if (!row) return undefined
    const meta = (row.meta ? JSON.parse(row.meta) : {}) as Record<string, string>
    if (!meta.recipient) return undefined
    return {
      composer: row.actor,
      recipient: meta.recipient,
      ...(meta.recipient_agent_id ? { recipientAgentId: meta.recipient_agent_id } : {}),
      text: row.body ?? '',
      at: row.ts,
    }
  }

  /**
   * A permission prompt the human can still answer (CC-96).
   *
   * Carries the SAME `ts` cutoff `humanQueue` applies, so the set of answerable
   * prompts is exactly the set `inbox` printed. An aged-out row is unanswerable
   * for the reason it is unlistable: the host sends nothing when the local
   * dialog wins, so a row this old is presumed already resolved, and answering
   * it would be a verdict on something nobody is waiting for. Hook rows are
   * exempt, for the reason given on `AGES_OUT`.
   */
  openApproval(msgId: string): OpenApproval | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM events
         WHERE msg_id = ? AND kind = 'approval_request' AND msg_id NOT IN (${CLOSED}) AND ${AGES_OUT}
         LIMIT 1`,
      )
      .get(msgId, Date.now() - APPROVAL_TTL_MS) as unknown as Row | undefined
    if (!row) return undefined
    const meta = (row.meta ? JSON.parse(row.meta) : {}) as Record<string, string>
    const toolName = meta.tool_name ?? 'a tool'
    if (meta.source === 'hook') return { source: 'hook', session: row.actor, toolName }
    if (!meta.request_id) return undefined
    return { source: 'channel', session: row.actor, requestId: meta.request_id, toolName }
  }

  /** Keyed on the row's kind alone: `openApproval`'s age and meta cutoffs say whether a prompt is answerable, not what it is. */
  isApprovalRequest(msgId: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS hit FROM events WHERE msg_id = ? AND kind = 'approval_request' LIMIT 1`)
      .get(msgId) as unknown as { hit: number } | undefined
    return row !== undefined
  }

  /**
   * The questions this session still has outstanding, not just how many.
   *
   * Teleport refuses while any are open, and a refusal a model cannot act on is
   * one it will retry against the same wall — so the reason has to name them,
   * the way `send_result.reason` names a route failure rather than reporting
   * "failed".
   */
  openQuestions(actor: string): QueueItem[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE actor = ? AND kind = 'question' AND msg_id NOT IN (${CLOSED}) AND msg_id NOT IN (${DECIDED})
         ORDER BY id ASC`,
      )
      .all(actor) as unknown as Row[]
    return rows.map(row => ({
      msgId: row.msg_id ?? String(row.id),
      kind: row.kind as QueueItem['kind'],
      from: row.actor,
      text: row.body ?? '',
      at: row.ts,
      meta: (row.meta ? JSON.parse(row.meta) : {}) as Record<string, string>,
    }))
  }

  /**
   * Peer traffic that landed in `name`'s inbox since `since`.
   *
   * Deliberately NOT called "unread": nothing anywhere tracks a read cursor, so
   * this counts what ARRIVED in a window the caller picks. Teleport uses it to
   * warn — never to refuse — since the descendant keeps the name and `chat_inbox`
   * still returns every one of these rows after the hop.
   */
  inboxCountSince(name: string, since: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM events
         WHERE target = ? AND kind IN (${INBOX_KINDS}) AND ts >= ?`,
      )
      .get(name, since) as unknown as { n: number }
    return row.n
  }

  undeliveredHandoffs(since: number): StoredHandoff[] {
    return undeliveredHandoffs(this.db, since)
  }

  /** An open `question` nobody has decided yet: the only thing a decider may answer. */
  undecidedQuestion(msgId: string): QueueItem | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM events
         WHERE msg_id = ? AND kind = 'question' AND target = 'human'
           AND msg_id NOT IN (${CLOSED}) AND msg_id NOT IN (${DECIDED})
         LIMIT 1`,
      )
      .get(msgId) as unknown as Row | undefined
    return row && toQueueItem(row)
  }

  /** The decider's answer to `questionId`, and the human answer that overruled it, if any. */
  decisionFor(questionId: string): Decision | undefined {
    const row = this.db
      .prepare(`SELECT * FROM events WHERE kind = 'decided' AND ref = ? ORDER BY id ASC LIMIT 1`)
      .get(questionId) as unknown as Row | undefined
    if (!row) return undefined
    // Append-only, so `overruled_by` is the human answer written after the decision, not a column.
    const overrule = this.db
      .prepare(
        `SELECT msg_id FROM events WHERE kind = 'answer' AND ref = ? AND id > ? ORDER BY id ASC LIMIT 1`,
      )
      .get(questionId, row.id) as unknown as { msg_id: string } | undefined
    return {
      ...this.decisionOf(row),
      ...(overrule ? { overruledBy: overrule.msg_id } : {}),
    }
  }

  /** Decisions from the last 24 hours the human has neither overruled nor dismissed, oldest first. */
  decidedQueue(): DecidedItem[] {
    const rows = this.db
      .prepare(
        `SELECT d.*, q.msg_id AS q_msg_id, q.actor AS q_actor, q.body AS q_body, q.ts AS q_ts, q.meta AS q_meta
         FROM events d JOIN events q ON q.msg_id = d.ref AND q.kind = 'question'
         WHERE d.kind = 'decided' AND d.ts > ? AND d.ref NOT IN (${CLOSED})
         ORDER BY d.id ASC`,
      )
      .all(Date.now() - DECISION_AUDIT_MS) as unknown as (Row & QuestionColumns)[]
    return rows.map(row => ({
      question: toQueueItem({
        ...row,
        kind: 'question',
        msg_id: row.q_msg_id,
        actor: row.q_actor,
        body: row.q_body,
        ts: row.q_ts,
        meta: row.q_meta,
      }),
      decision: this.decisionOf(row),
    }))
  }

  private decisionOf(row: Row): DecidedItem['decision'] {
    const meta = (row.meta ? JSON.parse(row.meta) : {}) as Record<string, string>
    return {
      ...citationOf(meta),
      msgId: row.msg_id ?? String(row.id),
      by: row.actor,
      text: row.body ?? '',
      at: row.ts,
    }
  }

  /** The session that raised `msgId`, so an answer knows where to go back to. */
  authorOf(msgId: string): string | undefined {
    const row = this.db.prepare(`SELECT actor FROM events WHERE msg_id = ? LIMIT 1`).get(msgId) as unknown as
      { actor: string } | undefined
    return row?.actor
  }

  isOpen(msgId: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS hit FROM events WHERE msg_id = ? AND msg_id NOT IN (${CLOSED}) LIMIT 1`)
      .get(msgId) as unknown as { hit: number } | undefined
    return row !== undefined
  }

  /**
   * Every row that bears on an agent identity, oldest first, for the fold in
   * `agents/identity.ts`.
   *
   * The db handle stays private and this returns plain rows rather than the read
   * model reaching in: the fold is then a pure function over a row list, unit
   * testable with no database at all, which is the point of the A1 ordering.
   */
  agentEvents(): AgentEventRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE kind IN (${AGENT_KINDS_SQL}) ORDER BY id ASC`)
      .all() as unknown as Row[]
    return rows.map(toAgentEventRow)
  }

  /** CC-476: one agent's rows, by the same id rule as `groupByAgent`, so a lookup skips the full fold. */
  agentEventsFor(agentId: string): AgentEventRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE kind IN (${AGENT_KINDS_SQL}) AND (
           (kind = 'agent_spawned' AND msg_id = ?) OR (kind <> 'agent_spawned' AND ref = ?)
         ) ORDER BY id ASC`,
      )
      .all(agentId, agentId) as unknown as Row[]
    return rows.map(toAgentEventRow)
  }

  history(limit: number): QueueItem[] {
    const rows = this.db
      .prepare(`SELECT * FROM (SELECT * FROM events ORDER BY id DESC LIMIT ?) ORDER BY id ASC`)
      .all(limit) as unknown as Row[]
    return rows.map(row => ({
      msgId: row.msg_id ?? String(row.id),
      kind: row.kind as QueueItem['kind'],
      from: row.actor,
      text: row.body ?? '',
      at: row.ts,
      meta: {
        ...((row.meta ? JSON.parse(row.meta) : {}) as Record<string, string>),
        ...(row.target ? { target: row.target } : {}),
        ...(row.ref ? { ref: row.ref } : {}),
      },
    }))
  }

  /**
   * The SSE tail's catch-up query. Ordered by id ASC because the frame id is the
   * client's resume cursor, and a cursor that goes backwards is worse than no
   * cursor at all.
   */
  since(afterId: number, limit: number): LoggedEventRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?`)
      .all(afterId, limit) as unknown as Row[]
    return rows.map(row => ({
      id: row.id,
      kind: row.kind as EventKind,
      ts: row.ts,
      actor: row.actor,
      target: row.target,
      msgId: row.msg_id,
      ref: row.ref,
      body: row.body,
      meta: (row.meta ? JSON.parse(row.meta) : {}) as Record<string, string>,
    }))
  }

  latestId(): number {
    const row = this.db.prepare(`SELECT MAX(id) AS max_id FROM events`).get() as unknown as {
      max_id: number | null
    }
    return row.max_id ?? 0
  }

  close(): void {
    this.db.close()
  }
}
