import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executionLedgerDdl, SqliteExecutionLedger } from '@titan-design/agent-lifecycle'
import type { ExecutionRecord } from '@titan-design/agent-protocol'
import {
  planBackfill,
  type BackfillOptions,
  type PlannedRow,
  type RuntimeRef,
} from '../agents/ledger/backfill.js'
import { backfillAtBoot, backfillDoneAt, runBackfill } from '../agents/ledger/backfill-run.js'
import { ledgerDbOver } from '../agents/ledger/db-shim.js'
import { writeRuntimeState } from '../agents/launch-files.js'
import { EventLog, type AgentEventRow } from '../broker/event-log.js'
import type { EventKind } from '../protocol.js'

/**
 * CC-118 slice 3: the backfill planner over fixture rows folded by `identity.ts`,
 * each plan applied through the published ledger so a plan the reducer would
 * reject fails here rather than at the D4 rehearsal.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-09-23T12:00:00.000Z')
const T0 = NOW - 10 * DAY_MS
const FENCE = { supervisorId: 'agent-chat@test', generation: 1 }
const OPTIONS: BackfillOptions = { now: NOW, fence: FENCE, configDir: '/config/test' }

const row = (
  kind: EventKind,
  agentId: string,
  ts: number,
  over: Partial<AgentEventRow> = {},
): AgentEventRow => ({
  kind,
  ts,
  actor: agentId,
  target: null,
  msgId: null,
  ref: agentId,
  body: null,
  meta: {},
  ...over,
})

const spawned = (agentId: string, ts: number, meta: Record<string, string> = {}): AgentEventRow =>
  row('agent_spawned', agentId, ts, {
    target: agentId,
    msgId: agentId,
    ref: null,
    meta: { session_id: `s-${agentId}`, ...meta },
  })

/** A spawned agent that attached and then exited with `code`. */
const finished = (
  agentId: string,
  at: number,
  meta: Record<string, string> = { code: '0' },
): AgentEventRow[] => [
  spawned(agentId, at),
  row('agent_attached', agentId, at + 1000),
  row('agent_exited', agentId, at + 2000, { meta }),
]

const plan = (
  rows: AgentEventRow[],
  runtime: Map<string, RuntimeRef> = new Map(),
  keys: Set<string> = new Set(),
  options: BackfillOptions = OPTIONS,
): PlannedRow[] => planBackfill(rows, runtime, keys, options)

/** Applies every planned row to an in-memory ledger and returns the final records. */
function applyAll(rows: PlannedRow[], ledger = memoryLedger()): ExecutionRecord[] {
  return rows.map(planned => {
    let last: ExecutionRecord | undefined
    for (const transition of planned.transitions) {
      const result = ledger.apply(transition)
      if (!result.ok) throw new Error(`${planned.agentId} ${transition.kind}: ${result.reason}`)
      last = result.record
    }
    return last as ExecutionRecord
  })
}

function memoryLedger(): SqliteExecutionLedger {
  const db = ledgerDbOver(new DatabaseSync(':memory:'))
  db.exec(executionLedgerDdl())
  return new SqliteExecutionLedger(db as never, { now: () => new Date(NOW).toISOString() })
}

describe('planBackfill', () => {
  it('maps spawned, attached, exited to prepared, dispatching, running, succeeded', () => {
    const [planned] = plan(finished('a1', T0))

    expect(planned?.phases).toEqual(['prepared', 'dispatching', 'running', 'succeeded'])
    const [record] = applyAll(plan(finished('a1', T0)))
    expect(record?.terminal).toEqual({
      outcome: 'succeeded',
      result: { code: 0, signal: null, inferred: false },
    })
    expect(record?.requestKey).toBe('backfill:a1')
  })

  it('finishes a non-zero exit as failed and a failed start as failed, neither retryable', () => {
    const records = applyAll(
      plan([
        ...finished('a1', T0, { code: '2' }),
        ...finished('a2', T0, { failed: 'true' }),
        ...finished('a3', T0, { inferred: 'true' }),
      ]),
    )

    expect(records.map(r => [r.phase, r.terminal?.outcome === 'failed' && r.terminal.retryable])).toEqual([
      ['failed', false],
      ['failed', false],
      ['succeeded', false],
    ])
  })

  it('leaves a spawned agent that never attached and never exited in dispatching', () => {
    const planned = plan([spawned('a1', T0)])

    expect(planned[0]?.phases).toEqual(['prepared', 'dispatching'])
    expect(applyAll(planned)[0]?.phase).toBe('dispatching')
  })

  it("names the conversation by the spawn row's config dir, else the broker's, and omits it without a session id", () => {
    const rows = [
      ...finished('a1', T0),
      spawned('a2', T0, { config_dir: '/config/other' }),
      row('agent_attached', 'a2', T0 + 1000),
      spawned('a3', T0, { session_id: '' }),
      row('agent_attached', 'a3', T0 + 1000),
    ]

    const records = applyAll(plan(rows))

    expect(records.map(r => [r.target, r.adapterExecution?.conversation])).toEqual([
      [
        { kind: 'fresh', namespace: '/config/test' },
        { harness: 'claude-code', namespace: '/config/test', nativeId: 's-a1' },
      ],
      [
        { kind: 'fresh', namespace: '/config/other' },
        { harness: 'claude-code', namespace: '/config/other', nativeId: 's-a2' },
      ],
      [{ kind: 'fresh', namespace: '/config/test' }, undefined],
    ])
  })

  it('gives a retired identity no row', () => {
    expect(plan([...finished('a1', T0), row('agent_retired', 'a1', T0 + 3000)])).toEqual([])
  })

  it('gives an adopted session no row', () => {
    const adopted = spawned('a1', T0, { origin: 'adopted' })

    expect(plan([adopted, row('agent_attached', 'a1', T0 + 1000)])).toEqual([])
  })

  it('yields one row per unretired teleport generation, the stood-down predecessor cancelled', () => {
    const rows = [
      spawned('gen1', T0),
      row('agent_attached', 'gen1', T0 + 1000),
      row('agent_stood_down', 'gen1', T0 + 2000),
      spawned('gen2', T0 + 3000, { generation: '2', teleport_from: 'gen1' }),
      row('agent_attached', 'gen2', T0 + 4000),
    ]

    const records = applyAll(plan(rows))

    expect(records.map(r => [r.agent?.agentId, r.phase])).toEqual([
      ['gen1', 'cancelled'],
      ['gen2', 'running'],
    ])
    expect(records[0]?.terminal).toEqual({ outcome: 'cancelled', reason: 'superseded by teleport' })
  })

  it('plans nothing on a second run over the keys the first one wrote', () => {
    const ledger = memoryLedger()
    const rows = [...finished('a1', T0), spawned('a2', T0)]
    const first = plan(rows)
    applyAll(first, ledger)

    const second = plan(rows, new Map(), new Set(first.map(p => p.requestKey)))

    expect(first).toHaveLength(2)
    expect(second).toEqual([])
    expect(plan([spawned('a3', T0)], new Map(), new Set(['spawn:a3']))).toEqual([])
  })

  it('takes the runnerRef from runtime.json and says unknown when there is none', () => {
    const rows = [...finished('a1', T0), ...finished('a2', T0), ...finished('a3', T0)]
    const runtime = new Map<string, RuntimeRef>([
      ['a1', { pid: 4242 }],
      ['a2', { paneRef: 'w0t0p1:ABC' }],
    ])

    const refs = applyAll(plan(rows, runtime)).map(r => r.runnerRef)

    expect(refs).toEqual(['pid:4242', 'pane:w0t0p1:ABC', 'unknown'])
  })

  it('never lets a timestamp decrease within a row, whatever order and clock the log holds', () => {
    const fixture = [
      ...finished('a1', T0),
      spawned('a2', T0),
      row('agent_attached', 'a2', T0),
      row('agent_detached', 'a2', T0),
      row('agent_exited', 'a2', T0, { meta: { inferred: 'true' } }),
      ...finished('a3', T0, { code: '1' }),
    ]
    const random = seeded(118)
    // Row order and wall clock both vary: a skewed clock can stamp an attach before its spawn.
    const skewed = (): AgentEventRow[] =>
      shuffle(fixture, random).map(r => ({ ...r, ts: T0 + Math.floor(random() * 12 * DAY_MS) }))

    for (let run = 0; run < 200; run += 1) {
      const planned = plan(skewed())
      for (const { transitions } of planned) {
        const times = transitions.map(t => Date.parse(t.occurredAt))
        expect(times).toEqual([...times].sort((a, b) => a - b))
        expect(Math.max(...times)).toBeLessThanOrEqual(NOW)
      }
      expect(() => applyAll(planned)).not.toThrow()
    }
  })

  it('with --since, excludes agents whose last event is older', () => {
    const rows = [...finished('old', NOW - 30 * DAY_MS), ...finished('recent', NOW - DAY_MS)]

    const bounded = plan(rows, new Map(), new Set(), { ...OPTIONS, sinceDays: 7 })

    expect(bounded.map(p => p.agentId)).toEqual(['recent'])
    expect(plan(rows).map(p => p.agentId)).toEqual(['old', 'recent'])
  })
})

/** Deterministic, so a failing shuffle can be replayed. */
function seeded(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31
    return state / 2 ** 31
  }
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j] as T, copy[i] as T]
  }
  return copy
}

describe('runBackfill against an events.db', () => {
  let dir: string
  let events: EventLog

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-backfill-'))
    process.env.AGENT_CHAT_HOME = dir
    events = new EventLog(path.join(dir, 'events.db'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    events.close()
    delete process.env.AGENT_CHAT_HOME
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const spawn = (name: string): string =>
    events.append({ kind: 'agent_spawned', actor: 'human', target: name, meta: { session_id: `s-${name}` } })
      .msgId

  const phases = (): string[] =>
    (
      events.ledgerHandle().prepare('SELECT phase FROM agent_execution ORDER BY request_key').all() as {
        phase: string
      }[]
    ).map(r => r.phase)

  it('writes each row once, reads runtime.json, and records backfill_done_at', () => {
    const a = spawn('alpha')
    events.append({ kind: 'agent_attached', actor: 'alpha', ref: a })
    spawn('beta')
    writeRuntimeState(a, {
      handle: { surface: 'headless', pid: 77 },
      allocation: { cwd: dir },
      isolation: 'none',
    })

    const first = runBackfill(events, { fence: FENCE })
    const second = runBackfill(events, { fence: FENCE })

    expect([first.applied, second.planned.length]).toEqual([2, 0])
    expect(phases().sort()).toEqual(['dispatching', 'running'])
    expect(first.planned.find(p => p.agentId === a)?.sources).toContainEqual({
      field: 'runnerRef',
      value: 'pid:77',
      from: 'runtime.json',
    })
    expect(backfillDoneAt(events.ledgerHandle())).toBeDefined()
  })

  it('does not mark a --since run as the completed backfill', () => {
    spawn('alpha')

    runBackfill(events, { fence: FENCE, sinceDays: 7 })

    expect(backfillDoneAt(events.ledgerHandle())).toBeUndefined()
  })

  it('at boot, runs once per home and never again after backfill_done_at is set', () => {
    spawn('alpha')
    backfillAtBoot(events, FENCE)
    spawn('beta')

    backfillAtBoot(events, FENCE)

    expect(phases()).toEqual(['dispatching'])
  })

  it('the CLI refuses while a broker holds the socket', async () => {
    const server = net.createServer().listen(path.join(dir, 'chat.sock'))
    await new Promise(resolve => server.once('listening', resolve))
    const exit = vi.spyOn(process, 'exit').mockImplementation(code => {
      throw new Error(`exit ${code}`)
    })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { buildProgram } = await import('../cli/index.js')

    await expect(buildProgram().parseAsync(['node', 'cli', 'lifecycle', 'backfill'])).rejects.toThrow(
      'exit 1',
    )

    expect(exit).toHaveBeenCalledWith(1)
    expect(
      events.ledgerHandle().prepare("SELECT 1 FROM sqlite_master WHERE name = 'agent_execution'").get(),
    ).toBeUndefined()
    await new Promise(resolve => server.close(resolve))
  })
})
