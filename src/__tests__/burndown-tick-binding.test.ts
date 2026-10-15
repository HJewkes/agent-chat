import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PoolRule, SpendCaps } from '../agents/burndown/budget-gate.js'
import type { CollisionKind } from '../agents/burndown/collision.js'
import { tickRowsSince } from '../agents/burndown/dispatch-stats.js'
import type { Refusal, Task } from '../agents/burndown/eligibility.js'
import { EMPTY_LEDGER } from '../agents/burndown/ledger.js'
import type { ScoreRow, ScoringDefaults } from '../agents/burndown/score.js'
import type { SeatDispatch } from '../agents/burndown/seat-dispatch.js'
import { planSeat } from '../agents/burndown/seat-plan.js'
import { tickSummary, tickSummaryWriter, type SummaryInputs } from '../agents/burndown/tick-summary.js'

/** CC-1097 c: each tick row names, per seat, the capacity lever that refused its first-ranked capped candidate. */

interface FixtureRow {
  id: string
  score: number
  collision?: CollisionKind
}

interface Fixture {
  now: string
  seat: string
  pool: PoolRule
  spend: SpendCaps
  runStartAt: string
  reading: { sevenDay: number; fiveHour: number; ageSeconds: number }
  history: { at: string; sevenDay: number; resetsAt?: string }[]
  rows: FixtureRow[]
}

const FIXTURE_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'ticks-2026-10-11T2343Z.json',
)
const FIXTURE = JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8')) as Fixture
const NOW = new Date(FIXTURE.now)
const REPO = '/tmp/repos/alpha-app'

const SEAT: SeatDispatch = {
  seat: FIXTURE.seat,
  prefix: 'sa',
  pool: FIXTURE.pool,
  configDir: '/tmp/workout',
  repos: { alpha: [REPO] },
  caps: { implementers: 4, reviewers: 1, planners: 1 },
  worktrees: { perRepoPerSeat: 5, capName: 'concurrency.implementers', leftFreePerRepo: 2 },
  excludedTags: [],
  grants: [],
}

const scoreRow = (r: FixtureRow): ScoreRow =>
  ({
    id: r.id,
    initiative: 'alpha',
    score: r.score,
    kind: 'platform',
    blocked: [],
    stopShort: [],
    route: 'implementer',
    components: { W: 1 },
  }) as unknown as ScoreRow

const task = (id: string): Task => ({
  id,
  title: `task ${id}`,
  status: 'open',
  priority: 1,
  estimate: 2,
  doneWhen: 'The widget renders.',
  tags: [],
})

const ms = (iso: string | undefined): number | undefined => (iso === undefined ? undefined : Date.parse(iso))

function planFixtureTick() {
  const collisions = new Map(
    FIXTURE.rows.flatMap(r => (r.collision === undefined ? [] : [[r.id, r.collision]])),
  )
  return planSeat({
    seat: SEAT,
    rows: FIXTURE.rows.map(scoreRow),
    defaults: { initiative_decay: 0.5, share_caps: {} } as unknown as ScoringDefaults,
    tasks: new Map([['alpha', FIXTURE.rows.map(r => task(r.id))]]),
    ledger: EMPTY_LEDGER,
    budget: {
      pool: FIXTURE.pool,
      spend: FIXTURE.spend,
      reading: FIXTURE.reading,
      history: FIXTURE.history.map(s => ({
        at: Date.parse(s.at),
        sevenDay: s.sevenDay,
        resetsAt: ms(s.resetsAt),
      })),
      runStartAt: Date.parse(FIXTURE.runStartAt),
      ctx: { now: NOW },
    },
    collision: (_repo, work) => {
      const kind = collisions.get(work.taskId)
      return kind === undefined ? undefined : { kind, reason: `${work.taskId} ${kind}` }
    },
  })
}

function summaryInputs(refusals: readonly Refusal[], skipped?: string): SummaryInputs {
  return {
    now: NOW,
    maxAgeDays: 14,
    caps: { [FIXTURE.seat]: SEAT.caps },
    outcomes: [
      {
        seat: FIXTURE.seat,
        dispatched: 0,
        refusals,
        ...(skipped === undefined ? { roles: { implementers: 0, reviewers: 0, planners: 0 } } : { skipped }),
      },
    ],
    dispatch: [],
    tasks: new Map(),
    registrations: [],
  }
}

describe('the 10-11 23:43Z tick binding', () => {
  it('names spend.per_run_points 60 against run spend 107 for the first budget-refused row', () => {
    const plan = planFixtureTick()

    const row = tickSummary(summaryInputs(plan.refusals))

    expect(plan.refusals.map(r => [r.task, r.kind])).toEqual([
      ['A-1', 'claimed'],
      ['A-2', 'file-overlap'],
      ['A-3', 'budget'],
      ['A-4', 'budget'],
      ['A-5', 'budget'],
    ])
    expect(row.seats[FIXTURE.seat]?.binding).toEqual({
      kind: 'budget',
      initiative: 'alpha',
      task: 'A-3',
      lever: 'spend.per_run_points',
      value: 60,
      reading: 107,
      headroom: -47,
      source: 'seats/seat-a.md',
    })
  })
})

describe('the binding on other ticks', () => {
  it('is null when only eligibility and collision gates refused', () => {
    const refusals = planFixtureTick().refusals.filter(r => r.kind !== 'budget')

    expect(tickSummary(summaryInputs(refusals)).seats[FIXTURE.seat]?.binding).toBeNull()
  })

  it('is absent for a skipped seat', () => {
    const row = tickSummary(summaryInputs([], 'no seat file'))

    expect(row.seats[FIXTURE.seat]).not.toHaveProperty('binding')
  })
})

describe('the row on disk', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tick-binding-'))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('stays v 1 so dispatch-stats still reads it, binding included', () => {
    const file = path.join(dir, 'burndown-ticks.jsonl')
    const row = tickSummary(summaryInputs(planFixtureTick().refusals))

    tickSummaryWriter(() => file)(row, () => {})
    const read = tickRowsSince(fs.readFileSync(file, 'utf8'), 0)

    expect(read).toHaveLength(1)
    expect(read[0]?.v).toBe(1)
    expect(read[0]?.seats[FIXTURE.seat]?.binding?.lever).toBe('spend.per_run_points')
  })
})
