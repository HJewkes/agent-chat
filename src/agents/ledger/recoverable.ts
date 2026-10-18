import type { DatabaseSync } from 'node:sqlite'
import { DEFAULT_EXECUTION_TABLE } from '@titan-design/agent-lifecycle'
import {
  EXECUTION_PHASES,
  isTerminalExecutionPhase,
  type ExecutionRecord,
} from '@titan-design/agent-protocol'

const LIVE_PHASES = EXECUTION_PHASES.filter(phase => !isTerminalExecutionPhase(phase))

/**
 * The package's `listRecoverable` with `phase IN` the live phases. Its `phase NOT IN`
 * cannot use the phase index, so it scans every finished execution on each call
 * (CC-1489). Deleted when agent-lifecycle ships the indexed query (TP-3518).
 */
export function listRecoverableIndexed(db: DatabaseSync, limit: number): ExecutionRecord[] {
  const rows = db
    .prepare(
      `SELECT record FROM "${DEFAULT_EXECUTION_TABLE}" WHERE phase IN (${LIVE_PHASES.map(() => '?').join(',')})
       ORDER BY prepared_at, execution_id LIMIT ?`,
    )
    .all(...LIVE_PHASES, limit) as { record: string }[]
  return rows.map(row => JSON.parse(row.record) as ExecutionRecord)
}
