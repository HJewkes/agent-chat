import type { DatabaseSync } from 'node:sqlite'
import type { EventStore, AgentEventRow } from '../../broker/event-store.js'
import { pushHoldFor, type PushHold } from '../../broker/push-hold.js'
import { HUMAN, type EventKind } from '../../protocol.js'
import { AgentLog, groupByAgent } from '../identity.js'
import { liveCoordinators } from './coordinators.js'
import type { HeldItem } from './held-relay.js'
import { openEvents } from './io.js'

/**
 * The held-message relay's reads. Every one opens events.db read-only and is bounded by `untilMs`,
 * so a pass can be replayed at a past instant. Nothing here constructs `EventLog`: its constructor
 * opens the file read-write, sets WAL and runs the schema.
 */

/** The kinds the broker's agent read model folds over (`event-log.ts` AGENT_KINDS). */
const AGENT_KINDS: readonly EventKind[] = [
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
]

/** The recipient's own rows that show it took a turn; an `inbox_read` receipt clears only the messages it names. */
const TURN_KINDS = "'message', 'broadcast', 'seat_activity'"
/** At most this many waiting messages per recipient, newest kept. */
const ITEM_LIMIT = 50

interface Row {
  ts: number
  kind: string
  actor: string
  target: string | null
  msg_id: string | null
  ref: string | null
  body: string | null
  meta: string | null
}

const toAgentRow = (row: Row): AgentEventRow => ({
  kind: row.kind as EventKind,
  ts: row.ts,
  actor: row.actor,
  target: row.target,
  msgId: row.msg_id,
  ref: row.ref,
  body: row.body,
  meta: (row.meta ? JSON.parse(row.meta) : {}) as Record<string, string>,
})

function agentRows(db: DatabaseSync, untilMs: number): AgentEventRow[] {
  const marks = AGENT_KINDS.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT * FROM events WHERE kind IN (${marks}) AND ts < ? ORDER BY id`)
    .all(...AGENT_KINDS, untilMs) as unknown as Row[]
  return rows.map(toAgentRow)
}

/** Same rule as `EventLog.humanContactSince`, but only rows before `untilMs`. */
function humanContactBefore(db: DatabaseSync, untilMs: number) {
  return (name: string, since: number): boolean =>
    db
      .prepare(
        `SELECT 1 FROM events WHERE target = ? AND ts >= ? AND ts < ?
         AND (kind IN ('answer', 'decided') OR (kind = 'message' AND actor = ?)) LIMIT 1`,
      )
      .get(name, since, untilMs, HUMAN) !== undefined
}

/** The slice of `EventStore` that `pushHoldFor` and `AgentLog` call, over rows read once. */
type HoldStore = Pick<EventStore, 'agentEvents' | 'agentEventsFor' | 'humanContactSince'>

function holdStore(rows: AgentEventRow[], contact: HoldStore['humanContactSince']): HoldStore {
  const groups = groupByAgent(rows)
  return {
    agentEvents: () => rows,
    agentEventsFor: id => groups.get(id) ?? [],
    humanContactSince: contact,
  }
}

/** The newest identity holding `name`, retired or not. */
function agentIdFor(agents: AgentLog, name: string): string | undefined {
  const named = agents.roster({ includeRetired: true }).filter(agent => agent.name === name)
  return named.sort((a, b) => a.spawnedAt - b.spawnedAt).at(-1)?.agentId
}

export interface HoldBook {
  coordinators: string[]
  holds: Map<string, PushHold | undefined>
}

/** Live coordinators at `untilMs`, and the push hold on each of `names` then. */
export function readHolds(dbPath: string, names: readonly string[], untilMs: number): HoldBook {
  const db = openEvents(dbPath)
  try {
    const rows = agentRows(db, untilMs)
    // pushHoldFor and AgentLog call only the methods HoldStore keeps.
    const store = holdStore(rows, humanContactBefore(db, untilMs)) as EventStore
    const agents = new AgentLog(store)
    const coordinators = liveCoordinators(rows)
    const holds = new Map<string, PushHold | undefined>()
    for (const name of new Set([...names, ...coordinators])) {
      const id = agentIdFor(agents, name)
      holds.set(name, id === undefined ? undefined : pushHoldFor(store, agents, id))
    }
    return { coordinators, holds }
  } finally {
    db.close()
  }
}

interface MessageRow {
  actor: string
  msg_id: string | null
  ts: number
  body: string | null
}

/** The msg ids `name`'s CC-1680 `inbox_read` receipts after row `afterId` and before `untilMs` name. */
function readReceipts(db: DatabaseSync, name: string, afterId: number, untilMs: number): Set<string> {
  const rows = db
    .prepare("SELECT meta FROM events WHERE actor = ? AND kind = 'inbox_read' AND id > ? AND ts < ?")
    .all(name, afterId, untilMs) as unknown as { meta: string | null }[]
  const ids = rows.flatMap(row => {
    const meta = (row.meta ? JSON.parse(row.meta) : {}) as Record<string, unknown>
    return typeof meta.msgIds === 'string' ? meta.msgIds.split(',') : []
  })
  return new Set(ids)
}

function waitingFor(db: DatabaseSync, name: string, cutoffMs: number, untilMs: number): MessageRow[] {
  const turn = db
    .prepare(`SELECT MAX(id) AS id FROM events WHERE actor = ? AND kind IN (${TURN_KINDS}) AND ts < ?`)
    .get(name, untilMs) as { id: number | null }
  const afterId = turn.id ?? 0
  const rows = db
    .prepare(
      "SELECT actor, msg_id, ts, body FROM events WHERE target = ? AND kind IN ('message', 'broadcast') " +
        'AND actor <> ? AND id > ? AND ts <= ? ORDER BY id DESC LIMIT ?',
    )
    .all(name, HUMAN, afterId, cutoffMs, ITEM_LIMIT) as unknown as MessageRow[]
  const read = readReceipts(db, name, afterId, untilMs)
  return rows.reverse().filter(row => row.msg_id === null || !read.has(row.msg_id))
}

/**
 * Per recipient, the peer messages that arrived after its own last turn row, that no `inbox_read`
 * receipt of its names, and that are at least `olderThanMs` old at `untilMs`, oldest first. A
 * message from the human is left out: it unparks.
 */
export function readHeldCandidates(
  dbPath: string,
  holds: ReadonlyMap<string, PushHold | undefined>,
  olderThanMs: number,
  untilMs: number,
): HeldItem[] {
  const db = openEvents(dbPath)
  try {
    return [...holds].flatMap(([recipient, hold]) =>
      waitingFor(db, recipient, untilMs - olderThanMs, untilMs).map(row => ({
        recipient,
        msgId: row.msg_id ?? `at-${row.ts}`,
        from: row.actor,
        ts: row.ts,
        body: row.body ?? '',
        hold,
      })),
    )
  } finally {
    db.close()
  }
}
