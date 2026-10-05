import type { DatabaseSync } from 'node:sqlite'

/**
 * CC-524: reads over stored `agent_handoff` rows. They take a database handle so the
 * broker's log and a read-only CLI open of the same file share one definition.
 */

export interface StoredHandoff {
  msgId: string
  /** The name that teleported, which its successor was to keep. */
  name: string
  predecessorId: string
  successorId: string
  text: string
  at: number
  /** The predecessor stood down after writing it, so the teleport was not aborted. */
  committed: boolean
  /** The successor's identity attached, so it had the handoff as its first turn. */
  delivered: boolean
  /** A session that started in the predecessor's directory was shown it; a holder of the name was not. */
  shownInCwd: boolean
}

/** How a recovery row says which match it was shown on, in `meta.recovered_by`. */
export type RecoveredBy = 'name' | 'cwd'

interface HandoffRow {
  msg_id: string | null
  actor: string
  ref: string | null
  body: string | null
  ts: number
  successor: string | null
  committed: number
  delivered: number
  shown_in_cwd: number
}

const STOOD_DOWN = `EXISTS (SELECT 1 FROM events s WHERE s.ref = h.ref AND s.kind = 'agent_stood_down' AND s.id > h.id)`
const ATTACHED = `EXISTS (SELECT 1 FROM events a
  WHERE a.ref = json_extract(h.meta, '$.successor') AND a.kind = 'agent_attached')`
const SUPERSEDED = `EXISTS (SELECT 1 FROM events n WHERE n.ref = h.ref AND n.kind = 'agent_handoff' AND n.id > h.id)`
/** The row `recoverHandoff` writes when it shows a handoff to a later session on a `by` match. */
const shown = (by: RecoveredBy): string => `EXISTS (SELECT 1 FROM events r
  WHERE r.ref = h.msg_id AND r.kind = 'message' AND r.actor = 'agent-chat'
    AND json_extract(r.meta, '$.recovered_by') = '${by}')`

const SELECT = `SELECT h.msg_id, h.actor, h.ref, h.body, h.ts,
  json_extract(h.meta, '$.successor') AS successor, ${STOOD_DOWN} AS committed, ${ATTACHED} AS delivered,
  ${shown('cwd')} AS shown_in_cwd
  FROM events h WHERE h.kind = 'agent_handoff'`

const toHandoff = (row: HandoffRow): StoredHandoff => ({
  msgId: row.msg_id ?? '',
  name: row.actor,
  predecessorId: row.ref ?? '',
  successorId: row.successor ?? '',
  text: row.body ?? '',
  at: row.ts,
  committed: row.committed === 1,
  delivered: row.delivered === 1,
  shownInCwd: row.shown_in_cwd === 1,
})

/** The newest handoff `name` wrote, whatever became of its teleport. */
export function lastHandoff(db: DatabaseSync, name: string): StoredHandoff | undefined {
  const row = db.prepare(`${SELECT} AND h.actor = ? ORDER BY h.id DESC LIMIT 1`).get(name)
  return row === undefined ? undefined : toHandoff(row as unknown as HandoffRow)
}

/**
 * Handoffs written at or after `since` that no holder of the name has read, newest first:
 * the teleport went through, the successor never attached, and no later session was shown
 * the text on a name match. One shown on a directory match stays, marked `shownInCwd`.
 * An earlier handoff of the same predecessor is an aborted attempt, so only its last counts.
 */
export function undeliveredHandoffs(db: DatabaseSync, since: number): StoredHandoff[] {
  const sql = `${SELECT} AND h.ts >= ? AND ${STOOD_DOWN} AND NOT ${ATTACHED}
    AND NOT ${SUPERSEDED} AND NOT ${shown('name')} ORDER BY h.id DESC`
  return (db.prepare(sql).all(since) as unknown as HandoffRow[]).map(toHandoff)
}
