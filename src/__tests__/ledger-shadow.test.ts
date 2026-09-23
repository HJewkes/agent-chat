import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executionLedgerDdl, SqliteExecutionLedger } from '@titan-design/agent-lifecycle'
import type { ExecutionTransition } from '@titan-design/agent-protocol'
import { resolveLedgerShadow } from '../config.js'
import { EventLog } from '../broker/event-log.js'
import { ledgerDbOver } from '../agents/ledger/db-shim.js'
import {
  openShadowLedger,
  shadowLedgerFromConfig,
  ShadowLedger,
  type ExecutionLedgerPort,
} from '../agents/ledger/shadow-ledger.js'

/**
 * CC-118 slice 0: the write-only shadow ledger over the event log's own
 * connection. Every case runs against a real `events.db` in a temp
 * `AGENT_CHAT_HOME`, never the live one.
 */

const T0 = Date.parse('2026-09-23T12:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000

let dir: string
let events: EventLog

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-ledger-'))
  process.env.AGENT_CHAT_HOME = dir
  events = new EventLog(path.join(dir, 'events.db'))
})

afterEach(() => {
  vi.restoreAllMocks()
  events.close()
  delete process.env.AGENT_CHAT_HOME
  delete process.env.AGENT_CHAT_LEDGER_SHADOW
  fs.rmSync(dir, { recursive: true, force: true })
})

/** A second ledger over the same tables, so tests can read what the write-only shadow wrote. */
function reader(): SqliteExecutionLedger {
  const db = ledgerDbOver(events.ledgerHandle())
  db.exec(executionLedgerDdl())
  return new SqliteExecutionLedger(db as never, { now: () => new Date(T0).toISOString() })
}

function prepare(shadow: ShadowLedger, executionId: string, agentId = 'agent-1'): ExecutionTransition {
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

function beginDispatch(shadow: ShadowLedger, executionId: string): ExecutionTransition {
  return {
    kind: 'begin_dispatch',
    executionId,
    eventId: `${executionId}:begin`,
    expectedRevision: 1,
    occurredAt: new Date(T0).toISOString(),
    fence: shadow.fence,
  }
}

function tableNames(): string[] {
  const rows = events.ledgerHandle().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
  return rows.map(row => String(row.name))
}

describe('ShadowLedger.apply', () => {
  it('never rejects and logs ledger_shadow_error on throw and on ok:false', async () => {
    const log = vi.fn()
    const throwing: ExecutionLedgerPort = {
      get: () => undefined,
      listRecoverable: () => [],
      apply: () => {
        throw new Error('disk gone')
      },
    }
    const thrower = new ShadowLedger(throwing, { supervisorId: 'test', now: () => T0, log })
    const real = openShadowLedger(events.ledgerHandle(), { supervisorId: 'test', now: () => T0, log })

    await expect(thrower.apply(prepare(thrower, 'e1'))).resolves.toBeUndefined()
    await expect(real.apply(beginDispatch(real, 'absent'))).resolves.toBeUndefined()

    expect(log).toHaveBeenCalledWith(
      'ledger_shadow_error',
      expect.objectContaining({ kind: 'thrown', executionId: 'e1', reason: 'Error: disk gone' }),
    )
    expect(log).toHaveBeenCalledWith(
      'ledger_shadow_error',
      expect.objectContaining({ kind: 'not_found', executionId: 'absent' }),
    )
  })

  it('two transitions for one execution apply in order under Promise.all', async () => {
    const log = vi.fn()
    const ledger = reader()
    let calls = 0
    const slowFirst: ExecutionLedgerPort = {
      get: id => ledger.get(id),
      listRecoverable: limit => ledger.listRecoverable(limit),
      apply: async t => {
        const delay = calls++ === 0 ? 20 : 0
        await new Promise(resolve => setTimeout(resolve, delay))
        return ledger.apply(t)
      },
    }
    const shadow = new ShadowLedger(slowFirst, { supervisorId: 'test', now: () => T0, log })

    await Promise.all([shadow.apply(prepare(shadow, 'e1')), shadow.apply(beginDispatch(shadow, 'e1'))])

    expect(log).not.toHaveBeenCalled()
    expect(ledger.get('e1')?.phase).toBe('dispatching')
  })
})

describe('ShadowLedger maintenance writes', () => {
  it('finishByAgent finishes that agent’s active row and leaves other agents’ rows alone', async () => {
    const log = vi.fn()
    const shadow = openShadowLedger(events.ledgerHandle(), { supervisorId: 'test', now: () => T0, log })
    await shadow.apply(prepare(shadow, 'mine', 'agent-1'))
    await shadow.apply(prepare(shadow, 'theirs', 'agent-2'))

    await shadow.finishByAgent('agent-1', { outcome: 'cancelled', reason: 'retired after restart' })

    expect(log).not.toHaveBeenCalled()
    expect(reader().get('mine')?.terminal).toEqual({ outcome: 'cancelled', reason: 'retired after restart' })
    expect(reader().get('theirs')?.phase).toBe('prepared')
  })

  it('renewIfDue renews only leases with under seven days left', async () => {
    let now = T0
    const shadow = openShadowLedger(events.ledgerHandle(), { supervisorId: 'test', now: () => now })
    await shadow.apply(prepare(shadow, 'old'))
    now = T0 + 5 * DAY_MS
    await shadow.apply(prepare(shadow, 'fresh'))
    now = T0 + 24 * DAY_MS
    const leaseOf = (id: string): string | undefined => reader().get(id)?.owner?.leaseUntil
    const freshLease = leaseOf('fresh')

    await shadow.renewIfDue()

    expect(leaseOf('old')).toBe(new Date(now + 30 * DAY_MS).toISOString())
    expect(leaseOf('fresh')).toBe(freshLease)
  })
})

describe('the ledgerShadow flag', () => {
  it('with the flag off no table exists and no ledger method is called', () => {
    process.env.AGENT_CHAT_LEDGER_SHADOW = '0'
    const handle = vi.fn(() => events.ledgerHandle())
    const methods = (['apply', 'get', 'listRecoverable'] as const).map(name =>
      vi.spyOn(SqliteExecutionLedger.prototype, name),
    )

    const ledger = shadowLedgerFromConfig(handle)

    expect(ledger).toBeUndefined()
    expect(handle).not.toHaveBeenCalled()
    expect(tableNames()).not.toContain('agent_execution')
    for (const method of methods) expect(method).not.toHaveBeenCalled()
  })

  it('with the flag on the ledger tables are created in events.db', () => {
    process.env.AGENT_CHAT_LEDGER_SHADOW = '1'

    const ledger = shadowLedgerFromConfig(() => events.ledgerHandle())

    expect(ledger).toBeInstanceOf(ShadowLedger)
    expect(tableNames()).toEqual(
      expect.arrayContaining(['events', 'agent_execution', 'agent_execution_event']),
    )
  })

  it.each([
    ['no config and no override', undefined, undefined, true],
    ['config false', { ledgerShadow: false }, undefined, false],
    ['config false, override 1', { ledgerShadow: false }, '1', true],
    ['config absent, override 0', {}, '0', false],
    ['a non-boolean value', { ledgerShadow: 'yes' }, undefined, true],
  ])('resolves %s', (_scenario, config, override, expected) => {
    if (config !== undefined) fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config))
    if (override !== undefined) process.env.AGENT_CHAT_LEDGER_SHADOW = override

    expect(resolveLedgerShadow()).toBe(expected)
  })
})

describe('native bindings', () => {
  it('boot loads no native binding', async () => {
    process.env.AGENT_CHAT_LEDGER_SHADOW = '1'
    const shadow = shadowLedgerFromConfig(() => events.ledgerHandle())
    if (!shadow) throw new Error('flag on should open the ledger')
    await shadow.apply(prepare(shadow, 'e1'))

    const loadedModules = Object.keys(createRequire(import.meta.url).cache)
    const sharedObjects = (process.report.getReport() as { sharedObjects: string[] }).sharedObjects

    expect(loadedModules.filter(file => file.endsWith('.node'))).toEqual([])
    // better-sqlite3 13 loads `prebuilds/<platform>.node`, not `better_sqlite3.node`, so match the package.
    expect(sharedObjects.filter(file => /better[-_]sqlite3/.test(file))).toEqual([])
  })
})
