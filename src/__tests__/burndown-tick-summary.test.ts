import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Task } from '../agents/burndown/eligibility.js'
import type { Step } from '../agents/burndown/execute.js'
import type { Claim, Ledger } from '../agents/burndown/ledger.js'
import type { Dispatch } from '../agents/burndown/plan.js'
import type { RegisterReply } from '../agents/burndown/shepherd.js'
import {
  adoptSeatOfRegistration,
  claimSeatOf,
  recordingRegister,
  tickSummary,
  tickSummaryWriter,
  type RegisterRecord,
  type SummaryInputs,
} from '../agents/burndown/tick-summary.js'

/** CC-929: the per-tick summary row S9's `dispatch-stats` reads. */

const NOW = new Date(2026, 1, 3, 12, 0)
const CAPS = { implementers: 2, reviewers: 1, planners: 1 }

const task = (id: string, ...tags: string[]): Task => ({ id, title: id, tags })

const claim = (taskId: string, phase: Claim['phase'], extra: Partial<Claim> = {}): Claim => ({
  taskId,
  initiative: 'demo',
  agentName: `st-${taskId}`,
  spawnedAt: NOW.toISOString(),
  phase,
  phaseAt: NOW.toISOString(),
  seat: 'seat-t',
  ...extra,
})

const dispatch = (taskId: string): Dispatch => ({
  initiative: 'demo',
  task: taskId,
  profile: 'bd-implementer',
  account: 'pool-t',
  cwd: '/w',
  repo: '/r',
  agentName: `st-${taskId}`,
  reason: 'test',
  seat: 'seat-t',
})

const LEDGER: Ledger = {
  version: 1,
  claims: [claim('T-9', 'reviewing'), claim('T-8', 'done'), claim('U-1', 'implementing', { seat: 'seat-u' })],
}

function inputs(overrides: Partial<SummaryInputs> = {}): SummaryInputs {
  return {
    now: NOW,
    maxAgeDays: 14,
    caps: { 'seat-t': CAPS },
    outcomes: [
      {
        seat: 'seat-t',
        dispatched: 1,
        roles: { implementers: 1, reviewers: 1, planners: 0 },
        refusals: [
          { initiative: 'demo', task: 'T-2', kind: 'untriaged', reason: 'r' },
          { initiative: 'demo', task: 'T-3', kind: 'role-cap', reason: 'r' },
          { initiative: 'demo', task: 'T-4', kind: 'role-cap', reason: 'r' },
          { initiative: '-', kind: 'plan-blocked', reason: 'backlog unreadable' },
        ],
      },
      { seat: 'seat-x', dispatched: 0, refusals: [], skipped: 'no seat file' },
    ],
    dispatch: [dispatch('T-1')],
    tasks: new Map([
      [
        'demo',
        [
          task('T-1', 'brief:ready=2026-02-02'),
          task('T-2'),
          task('T-3', 'brief:ready=2026-01-01'),
          task('T-4', 'brief:ready=2026-01-20'),
        ],
      ],
    ]),
    registrations: [
      { seat: 'seat-t', outcome: 'ok' },
      { seat: 'seat-t', outcome: 'refused' },
      { outcome: 'failed' },
    ],
    ...overrides,
  }
}

describe('the tick summary row', () => {
  it('records one seat with brief counts, dispatches, refusals by kind, roles and registrations', () => {
    const row = tickSummary(inputs())

    expect(row.v).toBe(1)
    expect(row.ts).toBe(NOW.toISOString())
    expect(row.seats['seat-t']).toEqual({
      ready: 2,
      unbriefed: 1,
      stale: 1,
      dispatched: 1,
      refusals: { untriaged: 1, 'role-cap': 2, 'plan-blocked': 1 },
      roles: { used: { implementers: 1, reviewers: 1, planners: 0 }, cap: CAPS },
      registrations: { ok: 1, refused: 1, failed: 0 },
    })
  })

  it('counts every registration at the top level, including those for no seat', () => {
    expect(tickSummary(inputs()).registrations).toEqual({ ok: 1, refused: 1, failed: 1 })
  })

  it('keeps a skipped seat with its reason and no roles', () => {
    expect(tickSummary(inputs()).seats['seat-x']).toEqual({
      ready: 0,
      unbriefed: 0,
      stale: 0,
      dispatched: 0,
      refusals: {},
      registrations: { ok: 0, refused: 0, failed: 0 },
      skipped: 'no seat file',
    })
  })

  it('has no seats outside seats mode', () => {
    const row = tickSummary(inputs({ outcomes: [], caps: {}, dispatch: [] }))

    expect(row.seats).toEqual({})
  })
})

describe('registration recording', () => {
  const registration = { target: { repo: 'o/r', pr: 9 }, task: 'demo/T-9', implementer: 'st-t-9' }
  const steps: Step[] = [{ kind: 'register', key: { taskId: 'T-9' }, registration }]

  it.each<[RegisterReply, RegisterRecord['outcome']]>([
    [{ ok: true }, 'ok'],
    [{ ok: false, refused: true, reason: 'no' }, 'refused'],
    [{ ok: false, refused: false, reason: 'down' }, 'failed'],
  ])('records %j as %s against the claim seat and passes the reply through', (reply, outcome) => {
    const into: RegisterRecord[] = []
    const register = recordingRegister(() => reply, claimSeatOf(steps, LEDGER), into)

    const answered = register(registration)

    expect(answered).toBe(reply)
    expect(into).toEqual([{ seat: 'seat-t', outcome }])
  })

  it('records a registration with no register step or claim against no seat', () => {
    const into: RegisterRecord[] = []
    const other = { ...registration, implementer: 'st-t-5' }

    recordingRegister(() => ({ ok: true }), claimSeatOf(steps, LEDGER), into)(other)

    expect(into).toEqual([{ outcome: 'ok' }])
  })

  it('gives an adopted PR to the seat whose longest prefix starts its implementer', () => {
    const seatOf = adoptSeatOfRegistration([
      { seat: 'seat-t', prefix: 'st', repos: [] },
      { seat: 'seat-u', prefix: 'st-u', repos: [] },
    ])

    expect(seatOf({ ...registration, implementer: 'st-u-t-4' })).toBe('seat-u')
    expect(seatOf({ ...registration, implementer: 'st-t-4' })).toBe('seat-t')
    expect(seatOf({ ...registration, implementer: 'xy-t-4' })).toBeUndefined()
  })
})

describe('the summary writer', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-tick-summary-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('appends one JSON line per row', () => {
    const file = path.join(dir, 'home', 'burndown-ticks.jsonl')
    const write = tickSummaryWriter(() => file)
    const row = tickSummary(inputs())

    write(row, () => {})
    write(row, () => {})

    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n')
    expect(lines.map(l => JSON.parse(l))).toEqual([row, row])
  })

  it('logs the first failed write once and never throws', () => {
    const file = path.join(dir, 'burndown-ticks.jsonl')
    fs.mkdirSync(file)
    const events: string[] = []
    const write = tickSummaryWriter(() => file)

    for (let i = 0; i < 3; i++) write(tickSummary(inputs()), event => events.push(event))

    expect(events).toEqual(['burndown_tick_summary_failed'])
  })
})
