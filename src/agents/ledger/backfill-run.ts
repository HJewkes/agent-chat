import type { DatabaseSync } from 'node:sqlite'
import { executionLedgerDdl, SqliteExecutionLedger } from '@titan-design/agent-lifecycle'
import type { ExecutionOwnerFence } from '@titan-design/agent-protocol'
import type { AgentEventRow } from '../../broker/event-store.js'
import { logEvent } from '../../broker/log.js'
import { readRuntimeState } from '../launch-files.js'
import { configDir } from '../transcript.js'
import { planBackfill, type PlannedRow, type RuntimeRef } from './backfill.js'
import { ledgerDbOver, type LedgerDb } from './db-shim.js'

const META_DDL = 'CREATE TABLE IF NOT EXISTS agent_ledger_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)'
const DONE_KEY = 'backfill_done_at'

/** The two reads the runner needs of the event log: its agent rows and its connection. */
export interface BackfillSource {
  agentEvents(): AgentEventRow[]
  ledgerHandle(): DatabaseSync
}

export interface BackfillRunOptions {
  fence: ExecutionOwnerFence
  now?: number
  sinceDays?: number | undefined
}

export interface BackfillOutcome {
  planned: PlannedRow[]
  applied: number
  rejected: { agentId: string; reason: string }[]
}

const tableExists = (db: DatabaseSync, name: string): boolean =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined

/** Read-only, so a dry run against a home that has never had a ledger creates nothing. */
function existingRequestKeys(db: DatabaseSync): Set<string> {
  if (!tableExists(db, 'agent_execution')) return new Set()
  const rows = db.prepare('SELECT request_key FROM agent_execution').all() as { request_key: string }[]
  return new Set(rows.map(row => row.request_key))
}

function runtimeRefs(rows: readonly AgentEventRow[]): Map<string, RuntimeRef> {
  const refs = new Map<string, RuntimeRef>()
  for (const row of rows) {
    if (row.kind !== 'agent_spawned' || row.msgId === null) continue
    const handle = readRuntimeState(row.msgId)?.handle
    if (handle) refs.set(row.msgId, { pid: handle.pid, paneRef: handle.paneRef })
  }
  return refs
}

export function planFromSource(source: BackfillSource, options: BackfillRunOptions): PlannedRow[] {
  const rows = source.agentEvents()
  return planBackfill(rows, runtimeRefs(rows), existingRequestKeys(source.ledgerHandle()), {
    now: options.now ?? Date.now(),
    fence: options.fence,
    configDir: configDir(),
    sinceDays: options.sinceDays,
  })
}

class RowRejected extends Error {}

/** One transaction per agent, so a rejected transition leaves no half-written row. */
function applyRow(ledgerDb: LedgerDb, ledger: SqliteExecutionLedger, row: PlannedRow): void {
  ledgerDb
    .transaction(() => {
      for (const transition of row.transitions) {
        const result = ledger.apply(transition)
        if (!result.ok) throw new RowRejected(`${transition.kind}: ${result.kind}: ${result.reason}`)
      }
    })
    .immediate()
}

export function runBackfill(source: BackfillSource, options: BackfillRunOptions): BackfillOutcome {
  const db = source.ledgerHandle()
  const ledgerDb = ledgerDbOver(db)
  ledgerDb.exec(executionLedgerDdl())
  ledgerDb.exec(META_DDL)
  // The package types `db` as better-sqlite3's Database; the shim serves only the calls it makes.
  const ledger = new SqliteExecutionLedger(ledgerDb as never)
  const outcome: BackfillOutcome = { planned: planFromSource(source, options), applied: 0, rejected: [] }
  for (const row of outcome.planned) {
    try {
      applyRow(ledgerDb, ledger, row)
      outcome.applied += 1
    } catch (err) {
      if (!(err instanceof RowRejected)) throw err
      outcome.rejected.push({ agentId: row.agentId, reason: err.message })
    }
  }
  // A bounded run leaves older agents unplanned, so only an unbounded one completes the backfill.
  if (options.sinceDays === undefined) markDone(db, options.now ?? Date.now())
  return outcome
}

function markDone(db: DatabaseSync, now: number): void {
  db.prepare('INSERT OR REPLACE INTO agent_ledger_meta (key, value) VALUES (?, ?)').run(
    DONE_KEY,
    new Date(now).toISOString(),
  )
}

export function backfillDoneAt(db: DatabaseSync): string | undefined {
  if (!tableExists(db, 'agent_ledger_meta')) return undefined
  const row = db.prepare('SELECT value FROM agent_ledger_meta WHERE key = ?').get(DONE_KEY) as
    { value: string } | undefined
  return row?.value
}

/** The broker's once-per-home backfill; a failure is logged, never allowed to stop the boot. */
export function backfillAtBoot(source: BackfillSource, fence: ExecutionOwnerFence): void {
  try {
    if (backfillDoneAt(source.ledgerHandle()) !== undefined) return
    const { planned, applied, rejected } = runBackfill(source, { fence })
    logEvent('ledger_backfill', { planned: planned.length, applied, rejected: rejected.length })
    for (const miss of rejected) logEvent('ledger_shadow_error', { kind: 'backfill_rejected', ...miss })
  } catch (err) {
    logEvent('ledger_shadow_error', { kind: 'thrown', op: 'backfill', reason: String(err) })
  }
}
