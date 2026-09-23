import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionRecord } from '@titan-design/agent-protocol'
import { openShadowLedger, type ShadowLedger } from '../agents/ledger/shadow-ledger.js'
import type { EventLog } from '../broker/event-log.js'
import {
  startSupervisor,
  type HarnessOptions,
  type RestartHarness,
  type SurfaceSpawn,
} from './helpers/restart-harness.js'

/**
 * CC-118 slice 1: the supervisor writes lifecycle transitions beside its
 * in-memory decisions. Assertions read the ledger tables over a second,
 * read-only connection, because the shadow the supervisor holds is write-only.
 */

const harnesses: RestartHarness[] = []
const readers: DatabaseSync[] = []

afterEach(() => {
  for (const reader of readers.splice(0)) reader.close()
  for (const h of harnesses.splice(0)) h.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
  delete process.env.AGENT_CHAT_LEDGER_SHADOW
})

const shadowOver = (events: EventLog): ShadowLedger =>
  openShadowLedger(events.ledgerHandle(), { supervisorId: 'agent-chat@test' })

function start(options: HarnessOptions = {}): RestartHarness {
  const h = startSupervisor({ ledger: shadowOver, ...options })
  harnesses.push(h)
  return h
}

/** Shadow writes are promise chains with no timers, so draining microtasks settles them. */
async function drain(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

function reader(h: RestartHarness): DatabaseSync {
  const db = new DatabaseSync(path.join(h.home, 'events.db'), { readOnly: true })
  readers.push(db)
  return db
}

function records(h: RestartHarness): ExecutionRecord[] {
  const rows = reader(h).prepare('SELECT record FROM agent_execution ORDER BY prepared_at').all()
  return rows.map(row => JSON.parse(String(row.record)) as ExecutionRecord)
}

function only(h: RestartHarness): ExecutionRecord {
  const all = records(h)
  expect(all).toHaveLength(1)
  return all[0] as ExecutionRecord
}

function phases(h: RestartHarness, executionId: string): string[] {
  const sql =
    "SELECT json_extract(record, '$.phase') AS phase FROM agent_execution_event WHERE execution_id = ? ORDER BY revision"
  return reader(h)
    .prepare(sql)
    .all(executionId)
    .map(row => String(row.phase))
}

function ledgerTables(h: RestartHarness): string[] {
  const sql = "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'agent_execution%'"
  return reader(h)
    .prepare(sql)
    .all()
    .map(row => String(row.name))
}

/** A headless child whose exit the test decides. */
function exitingChild(pid = 4243) {
  let onExit: ((code: number | null, signal: string | null) => void) | undefined
  const spawn = () => ({
    pid,
    unref: () => undefined,
    once: (event: string, listener: (code: number | null, signal: string | null) => void) => {
      if (event === 'exit') onExit = listener
    },
  })
  return {
    spawn: spawn as unknown as SurfaceSpawn,
    started: () => onExit !== undefined,
    exit: (code: number | null, signal: string | null = null) => onExit?.(code, signal),
  }
}

function liveEntry(h: RestartHarness, agentId: string): { isolation: string } {
  const live = (h.supervisor as unknown as { live: Map<string, { isolation: string }> }).live
  return live.get(agentId) as { isolation: string }
}

describe('spawn and attach', () => {
  it('spawn writes prepared then dispatching, and attach writes running with the pid as runnerRef', async () => {
    const h = start({ slots: 1 })

    const spawned = await h.spawnAgent('scout')
    const refused = await h.spawnAgent('second')
    await drain()

    expect(refused.ok).toBe(false)
    expect(refused.reason).toMatch(/no free agent slots/)
    const record = only(h)
    expect(phases(h, record.execution.executionId)).toEqual(['prepared', 'dispatching', 'running'])
    expect(record).toMatchObject({
      agent: { agentId: spawned.agentId },
      requestKey: `spawn:${spawned.agentId}`,
      target: { kind: 'fresh', namespace: expect.any(String) },
      adapterExecution: { conversation: { harness: 'claude-code' } },
      runnerRef: '4242',
      surface: { kind: 'headless', nativeId: '4242', owned: false },
    })
  })

  it('reattach after a restart writes no transition', async () => {
    const h = start()
    await h.spawnAgent('scout')
    await drain()
    const before = phases(h, only(h).execution.executionId)

    h.restart()
    h.reattach(['scout'])
    await drain()

    expect(phases(h, only(h).execution.executionId)).toEqual(before)
  })
})

describe('exits', () => {
  it('a headless exit with code 0 finishes succeeded with inferred false', async () => {
    const child = exitingChild()
    const h = start({ spawn: child.spawn })
    await h.spawnAgent('scout')

    child.exit(0)
    await drain()

    expect(only(h).terminal).toEqual({
      outcome: 'succeeded',
      result: { code: 0, signal: null, inferred: false },
    })
  })

  it('a detach that outlasts the settle window finishes succeeded with inferred true', async () => {
    vi.useFakeTimers()
    const h = start({ settleMs: 1_000 })
    const agentId = String((await h.spawnAgent('scout')).agentId)

    h.core.append({ kind: 'agent_detached', actor: 'scout', ref: agentId })
    await vi.advanceTimersByTimeAsync(1_001)
    await drain()

    expect(only(h).terminal).toEqual({
      outcome: 'succeeded',
      result: { code: null, signal: null, inferred: true },
    })
  })

  it('a launch that never registers finishes failed, not retryable', async () => {
    const child = exitingChild()
    const h = start({ spawn: child.spawn, attach: false })

    const pending = h.spawnAgent('scout')
    await vi.waitFor(() => expect(child.started()).toBe(true))
    child.exit(1)
    const outcome = await pending
    await drain()

    expect(outcome.ok).toBe(false)
    expect(only(h).terminal).toMatchObject({
      outcome: 'failed',
      retryable: false,
      reason: expect.stringMatching(/never registered/),
    })
  })
})

describe('retire and kill', () => {
  it('retire of a live agent finishes cancelled "retired"', async () => {
    const h = start()
    await h.spawnAgent('scout')

    const result = await h.supervisor.retire('scout')
    await drain()

    expect(result.ok).toBe(true)
    expect(only(h).terminal).toEqual({ outcome: 'cancelled', reason: 'retired' })
  })

  it('retire after a restart finishes the row opened before the restart', async () => {
    const h = start()
    await h.spawnAgent('scout')
    await drain()

    h.restart()
    const result = await h.supervisor.retire('scout')
    await drain()

    expect(result.ok).toBe(true)
    expect(only(h).terminal).toEqual({ outcome: 'cancelled', reason: 'retired after restart' })
  })

  it('retire refused by isolation writes nothing', async () => {
    const h = start()
    const agentId = String((await h.spawnAgent('scout')).agentId)
    // A worktree strategy with no worktree reference refuses release, as a dirty worktree would.
    liveEntry(h, agentId).isolation = 'worktree'

    const result = await h.supervisor.retire('scout')
    await drain()

    expect(result.ok).toBe(false)
    expect(only(h).phase).toBe('running')
  })

  it('kill writes cancel_requested and the exit finishes cancelled', async () => {
    vi.useFakeTimers()
    const signal = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const child = exitingChild()
    const h = start({ spawn: child.spawn })
    await h.spawnAgent('scout')

    expect(h.supervisor.kill('scout').ok).toBe(true)
    await drain()
    const cancelling = only(h)
    child.exit(null, 'SIGTERM')
    await drain()

    expect(signal).toHaveBeenCalledWith(4243, 'SIGTERM')
    expect(cancelling.phase).toBe('cancel_requested')
    expect(only(h).terminal).toEqual({ outcome: 'cancelled', reason: 'exited after a cancellation request' })
  })
})

describe('the shadow never changes an outcome', () => {
  const throwing = (): ShadowLedger =>
    new Proxy({} as ShadowLedger, {
      get: () => () => {
        throw new Error('ledger down')
      },
    })
  // `newLease` is synchronous on the real ledger; only the writes can reject.
  const rejecting = (): ShadowLedger =>
    new Proxy({} as ShadowLedger, {
      get: (_target, key) =>
        key === 'newLease'
          ? () => ({ supervisorId: 'agent-chat@test', generation: 1, leaseUntil: '2100-01-01T00:00:00.000Z' })
          : () => Promise.reject(new Error('ledger down')),
    })

  async function lifecycle(ledger: NonNullable<HarnessOptions['ledger']>): Promise<unknown[]> {
    const child = exitingChild()
    const h = start({ spawn: child.spawn, ledger })
    const exiting = await h.spawnAgent('exits')
    child.exit(0)
    await drain()
    const retiring = await h.spawnAgent('retires')
    const retired = await h.supervisor.retire('retires')
    const kinds = h.core.events.agentEvents().map(row => row.kind)
    return [exiting.ok, retiring.ok, retired, kinds, h.semaphore.summary()]
  }

  it('every ledger method throwing leaves spawn, exit, retire outcomes unchanged', async () => {
    const baseline = await lifecycle(() => undefined)

    expect(await lifecycle(throwing)).toEqual(baseline)
    expect(await lifecycle(rejecting)).toEqual(baseline)
  })
})

describe('the ledgerShadow flag', () => {
  it('with the flag off no ledger table is created and the supervisor behaves the same', async () => {
    process.env.AGENT_CHAT_LEDGER_SHADOW = '0'
    const h = startSupervisor()
    harnesses.push(h)

    const spawned = await h.spawnAgent('scout')
    const retired = await h.supervisor.retire('scout')

    expect(spawned.ok).toBe(true)
    expect(retired.ok).toBe(true)
    expect(ledgerTables(h)).toEqual([])
  })

  it('AGENT_CHAT_LEDGER_SHADOW=1 turns the shadow on for the restart harness', async () => {
    process.env.AGENT_CHAT_LEDGER_SHADOW = '1'
    const h = startSupervisor()
    harnesses.push(h)

    await h.spawnAgent('scout')
    await drain()

    expect(only(h).phase).toBe('running')
  })
})
