import type { DatabaseSync, SQLInputValue } from 'node:sqlite'

/**
 * The slice of better-sqlite3's `Database` that `SqliteExecutionLedger` calls,
 * served over the `node:sqlite` connection the event log already holds. It
 * exists so the ledger never loads a native binding (CC-118, D1); it is deleted
 * when store-sqlite ships its `node:sqlite` adapter (TP-197).
 */
export interface LedgerStatement {
  get(...params: SQLInputValue[]): unknown
  all(...params: SQLInputValue[]): unknown[]
  run(...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint }
}

export interface LedgerDb {
  prepare(sql: string): LedgerStatement
  exec(sql: string): void
  transaction<T>(fn: () => T): { immediate(): T }
}

export function ledgerDbOver(db: DatabaseSync): LedgerDb {
  let depth = 0
  const inTransaction = <T>(fn: () => T): T => {
    depth += 1
    try {
      return runAtomically(db, `ledger_sp_${depth}`, fn)
    } finally {
      depth -= 1
    }
  }
  return {
    prepare: sql => db.prepare(sql),
    exec: sql => db.exec(sql),
    transaction: fn => ({ immediate: () => inTransaction(fn) }),
  }
}

/** A savepoint when a transaction is already open, because `BEGIN` inside `BEGIN` is an error. */
function runAtomically<T>(db: DatabaseSync, savepoint: string, fn: () => T): T {
  const nested = db.isTransaction
  db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT')
    return result
  } catch (err) {
    db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK')
    throw err
  }
}
