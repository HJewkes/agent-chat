import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { executionLedgerDdl, SqliteExecutionLedger } from '@titan-design/agent-lifecycle'
import { EXECUTION_PHASES, type ExecutionTransition } from '@titan-design/agent-protocol'
import { EventLog } from '../broker/event-log.js'
import { ledgerDbOver } from '../agents/ledger/db-shim.js'
import { listRecoverableIndexed } from '../agents/ledger/recoverable.js'
import { openShadowLedger, type ShadowLedger } from '../agents/ledger/shadow-ledger.js'
import { readLedger } from '../agents/ledger/verifier.js'

/**
 * CC-1489: a retire of an agent the broker no longer holds lists the ledger's
 * live rows. That read must use the phase index, or every retire scans every
 * finished execution. Byte counters cannot see it at test scale because the
 * page cache holds the whole table, so the query plan is the observable.
 */

const T0 = Date.parse('2026-09-23T12:00:00.000Z')

let dir: string
let events: EventLog

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-recoverable-'))
  process.env.AGENT_CHAT_HOME = dir
  events = new EventLog(path.join(dir, 'events.db'))
  ledgerDbOver(events.ledgerHandle()).exec(executionLedgerDdl())
})

afterEach(() => {
  events.close()
  delete process.env.AGENT_CHAT_HOME
  fs.rmSync(dir, { recursive: true, force: true })
})

function reader(): SqliteExecutionLedger {
  return new SqliteExecutionLedger(ledgerDbOver(events.ledgerHandle()) as never)
}

/** A snapshot row written directly, so a phase no transition reaches cheaply can still be seeded. */
function seedRow(executionId: string, phase: string, preparedAt: string, agentId: string): void {
  const record = { execution: { executionId }, agent: { agentId }, phase, preparedAt }
  events
    .ledgerHandle()
    .prepare(
      `INSERT INTO agent_execution (execution_id, request_key, phase, revision, owner_generation,
       prepared_at, updated_at, record) VALUES (?, ?, ?, 1, 1, ?, ?, ?)`,
    )
    .run(executionId, `spawn:${executionId}`, phase, preparedAt, preparedAt, JSON.stringify(record))
}

function prepare(shadow: ShadowLedger, executionId: string, agentId: string): ExecutionTransition {
  return {
    kind: 'prepare',
    executionId,
    eventId: `${executionId}:prepare`,
    expectedRevision: 0,
    occurredAt: new Date(T0).toISOString(),
    execution: { executionId },
    agent: { agentId },
    harness: 'claude-code',
    requestKey: `spawn:${executionId}`,
    target: { kind: 'fresh', namespace: dir },
    owner: shadow.newLease(),
  }
}

/** Records every SELECT that reads the execution snapshot table. */
function recordSnapshotReads(): string[] {
  const db = events.ledgerHandle()
  const original = db.prepare.bind(db)
  const reads: string[] = []
  db.prepare = (sql: string) => {
    if (/^\s*SELECT/i.test(sql) && /\bagent_execution\b/.test(sql)) reads.push(sql)
    return original(sql)
  }
  return reads
}

function planOf(sql: string): string[] {
  const rows = events.ledgerHandle().prepare(`EXPLAIN QUERY PLAN ${sql}`).all()
  return rows.map(row => String(row.detail))
}

describe('listing live executions', () => {
  it('finishing a retired agent reads no finished execution', async () => {
    for (let i = 0; i < 500; i++) seedRow(`done-${i}`, 'succeeded', new Date(T0 + i).toISOString(), 'impl-0')
    const shadow = openShadowLedger(events.ledgerHandle(), { supervisorId: 'test', now: () => T0 })
    const agents = ['impl-1', 'impl-2', 'impl-3', 'seat-a', 'seat-b']
    for (const agent of agents) await shadow.apply(prepare(shadow, `live-${agent}`, agent))
    const reads = recordSnapshotReads()

    for (const agent of agents) await shadow.finishByAgent(agent, { outcome: 'cancelled', reason: 'retired' })

    expect(reads.some(sql => /phase\s+(NOT\s+)?IN/i.test(sql))).toBe(true)
    for (const sql of reads) expect(planOf(sql).join('\n')).not.toMatch(/SCAN "?agent_execution"?(\s|$)/)
    for (const agent of agents) expect(reader().get(`live-${agent}`)?.phase).toBe('cancelled')
  })

  it('the verifier lists live executions through the phase index', () => {
    for (let i = 0; i < 500; i++) seedRow(`done-${i}`, 'succeeded', new Date(T0 + i).toISOString(), 'impl-0')
    seedRow('live-1', 'running', new Date(T0).toISOString(), 'impl-1')
    const reads = recordSnapshotReads()

    const reading = readLedger(events.ledgerHandle())

    const recoverable = reads.filter(sql => /ORDER BY prepared_at/i.test(sql))
    expect(recoverable).toHaveLength(1)
    expect(planOf(recoverable[0] ?? '').join('\n')).not.toMatch(/SCAN "?agent_execution"?(\s|$)/)
    expect(reading?.active.map(row => row.executionId)).toEqual(['live-1'])
  })

  it('the indexed read returns what the package read returns, in every phase and under a limit', () => {
    EXECUTION_PHASES.forEach((phase, i) => {
      const preparedAt = new Date(T0 + ((i * 7) % 10) * 1000).toISOString()
      seedRow(`exec-${phase}`, phase, preparedAt, `impl-${i}`)
    })
    const db = events.ledgerHandle()

    for (const limit of [EXECUTION_PHASES.length, 2]) {
      expect(listRecoverableIndexed(db, limit)).toEqual(reader().listRecoverable(limit))
    }
    expect(listRecoverableIndexed(db, EXECUTION_PHASES.length)).toHaveLength(5)
  })
})
