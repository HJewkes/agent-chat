import { createRequire } from 'node:module'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { executionLedgerDdl, SqliteExecutionLedger } from '@titan-design/agent-lifecycle'
import type { ExecutionTransition } from '@titan-design/agent-protocol'
import { ledgerDbOver, type LedgerDb } from '../agents/ledger/db-shim.js'

/**
 * The node:sqlite shim that lets agent-lifecycle's ledger run without
 * better-sqlite3's native binding (CC-118 slice 0). Loaded the way
 * `event-log.ts` loads it, through `createRequire`.
 */
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => DatabaseSyncType
}

const openDbs: DatabaseSyncType[] = []

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close()
})

function setup(): { db: DatabaseSyncType; shim: LedgerDb } {
  const db = new DatabaseSync(':memory:')
  openDbs.push(db)
  db.exec('CREATE TABLE t (v INTEGER)')
  return { db, shim: ledgerDbOver(db) }
}

function values(shim: LedgerDb): number[] {
  return (shim.prepare('SELECT v FROM t ORDER BY v').all() as Array<{ v: number }>).map(row => row.v)
}

function insert(shim: LedgerDb, v: number): void {
  shim.prepare('INSERT INTO t (v) VALUES (?)').run(v)
}

describe('ledgerDbOver', () => {
  it('commits a transaction and rolls back on throw', () => {
    const { db, shim } = setup()

    shim.transaction(() => insert(shim, 1)).immediate()
    const failing = shim.transaction(() => {
      insert(shim, 2)
      throw new Error('boom')
    })

    expect(() => failing.immediate()).toThrow('boom')
    expect(values(shim)).toEqual([1])
    expect(db.isTransaction).toBe(false)
  })

  it('nests as a savepoint when a transaction is already open', () => {
    const { db, shim } = setup()

    shim
      .transaction(() => {
        insert(shim, 1)
        expect(() =>
          shim
            .transaction(() => {
              insert(shim, 2)
              throw new Error('inner')
            })
            .immediate(),
        ).toThrow('inner')
        shim.transaction(() => insert(shim, 3)).immediate()
      })
      .immediate()
    db.exec('BEGIN')
    shim.transaction(() => insert(shim, 4)).immediate()
    db.exec('COMMIT')

    expect(values(shim)).toEqual([1, 3, 4])
  })

  it('rolls the snapshot back if the event receipt cannot commit', () => {
    const { db, shim } = setup()
    shim.exec(executionLedgerDdl())
    const at = new Date().toISOString()
    const fence = { supervisorId: 'owner-a', generation: 1 }
    const ledger = new SqliteExecutionLedger(shim as never)
    const prepare: ExecutionTransition = {
      kind: 'prepare',
      executionId: 'execution',
      eventId: 'prepare',
      expectedRevision: 0,
      occurredAt: at,
      execution: { executionId: 'execution' },
      harness: 'claude-code',
      requestKey: 'request',
      target: { kind: 'fresh', namespace: 'host' },
      owner: { ...fence, leaseUntil: new Date(Date.now() + 60_000).toISOString() },
    }
    const prepared = ledger.apply(prepare)
    if (!prepared.ok) throw new Error(prepared.reason)
    db.exec(`CREATE TRIGGER reject_begin BEFORE INSERT ON agent_execution_event
      WHEN NEW.event_id = 'begin' BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END;`)

    const begin = () =>
      ledger.apply({
        kind: 'begin_dispatch',
        executionId: 'execution',
        eventId: 'begin',
        expectedRevision: prepared.record.revision,
        occurredAt: at,
        fence,
      })

    expect(begin).toThrow(/injected receipt failure/)
    expect(ledger.get('execution')).toEqual(prepared.record)
    expect(ledger.events('execution')).toHaveLength(1)
  })
})
