import { SqliteExecutionLedger } from '@titan-design/agent-lifecycle'
import { logEvent } from '../../broker/log.js'
import type { LedgerDb } from './db-shim.js'

/** A row recovery skipped goes to the broker log rather than the console nobody reads. */
export const logSkippedExecution = (line: string): void => {
  logEvent('ledger_shadow_error', { kind: 'unreadable', op: 'list_recoverable', reason: line })
}

/** The published ledger over the shim, reporting skipped rows to the broker log. */
export function recoverableReader(db: LedgerDb): SqliteExecutionLedger {
  // The package types `db` as better-sqlite3's Database; the shim serves only the calls it makes.
  return new SqliteExecutionLedger(db as never, { warn: logSkippedExecution })
}
