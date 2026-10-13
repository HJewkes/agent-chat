import { openEvents } from './io.js'

/** CC-610: an agent whose tool call is parked on `agent-chat permission-hook`, waiting for the human. */
export interface WaitingPermission {
  agent: string
  tool: string
  /** ISO time the hook filed its prompt. */
  since: string
}

/**
 * The hook's `--deadline 1790` plus a minute. Hook rows never age out of the queue, so a
 * row the broker failed to close would otherwise read as waiting forever.
 */
export const WAITING_PERMISSION_WINDOW_MS = 1_850_000

/** Oldest first. Open means no answer or resolution references it, the event log's own rule. Throws when events.db cannot be read. */
export function readWaitingPermission(
  dbPath: string,
  nowMs: number,
  windowMs = WAITING_PERMISSION_WINDOW_MS,
): WaitingPermission[] {
  const db = openEvents(dbPath)
  try {
    const rows = db
      .prepare(
        `SELECT actor, ts, json_extract(meta, '$.tool_name') AS tool FROM events
         WHERE kind = 'approval_request' AND json_extract(meta, '$.source') = 'hook' AND ts > ?
           AND msg_id NOT IN (
             SELECT ref FROM events WHERE kind IN ('answer', 'resolution') AND ref IS NOT NULL
           )
         ORDER BY id`,
      )
      .all(nowMs - windowMs) as unknown as { actor: string; ts: number; tool: string | null }[]
    return rows.map(row => ({
      agent: row.actor,
      tool: row.tool ?? 'unknown',
      since: new Date(row.ts).toISOString(),
    }))
  } finally {
    db.close()
  }
}
