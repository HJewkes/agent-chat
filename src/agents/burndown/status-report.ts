import { isTerminalReport } from '../../broker/event-log.js'
import { openEvents } from '../seats/io.js'
import { parseReport, type Report } from './report.js'

/**
 * CC-980: a finished worker's report is the last return-contract message it sent its report recipient, read from
 * events.db. The transcript's last text is not reliable: a Shepherd fix-round resume or prose after `chat_send`
 * replaces it, and the claim then stalls on prose while its `Status: DONE` row sits in the log.
 */

/**
 * The newest terminal report `name` sent `reportTo` at or after `since` (ms), the row's `spawnedAt`, so an earlier
 * dispatch under the same name is ignored. Undefined when there is none or the db cannot be read.
 */
export function readStatusReport(
  dbPath: string,
  name: string,
  reportTo: string,
  since: number,
): string | undefined {
  try {
    const db = openEvents(dbPath)
    try {
      const rows = db
        .prepare(
          `SELECT body FROM events
           WHERE actor = ? AND target = ? AND kind = 'message' AND ts >= ?
           ORDER BY id DESC`,
        )
        .all(name, reportTo, since) as { body: string | null }[]
      return rows.map(row => row.body ?? '').find(isTerminalReport)
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}

/** A parked final text wins, since parking is the transcript's last word; otherwise the broker report, then the text. */
export function pickReport(broker: string | undefined, final: string | undefined): Report | undefined {
  const fromText = final === undefined ? undefined : parseReport(final)
  if (fromText?.parked !== undefined) return fromText
  return broker === undefined ? fromText : parseReport(broker)
}
