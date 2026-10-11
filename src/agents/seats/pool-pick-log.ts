import { openEvents } from './io.js'

/** CC-606: the broker's last pool picks for a seat, read back from the notice rows it wrote. */

export interface PoolPickLine {
  at: string
  text: string
}

export interface PoolPickStatus {
  /** Newest first. Empty when events.db cannot be read, with `error` saying why. */
  last: PoolPickLine[]
  error?: string
}

export const POOL_PICKS_SHOWN = 3

/** Throws when events.db cannot be read. */
export function readPoolPicks(dbPath: string, seat: string, limit = POOL_PICKS_SHOWN): PoolPickLine[] {
  const db = openEvents(dbPath)
  try {
    const rows = db
      .prepare(
        `SELECT ts, body FROM events WHERE kind = 'notice' AND target = ? AND meta LIKE '%"pool_pick"%' ORDER BY id DESC LIMIT ?`,
      )
      .all(seat, limit) as unknown as { ts: number; body: string | null }[]
    return rows.map(row => ({ at: new Date(row.ts).toISOString(), text: row.body ?? '' }))
  } finally {
    db.close()
  }
}
