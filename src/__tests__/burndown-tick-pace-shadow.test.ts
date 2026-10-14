import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { PoolRule, ShadowCaps, SpendCaps } from '../agents/burndown/budget-gate.js'
import type { Task } from '../agents/burndown/eligibility.js'
import { EMPTY_LEDGER } from '../agents/burndown/ledger.js'
import type { ScoreRow, ScoringDefaults } from '../agents/burndown/score.js'
import type { SeatDispatch } from '../agents/burndown/seat-dispatch.js'
import { planSeat, type SeatPlan } from '../agents/burndown/seat-plan.js'
import { tickSummary } from '../agents/burndown/tick-summary.js'

/** CC-1104 b: under `paceController: shadow` each seat row logs the legacy and pace decisions; legacy still dispatches. */

interface Fixture {
  now: string
  seat: string
  pool: PoolRule
  spend: SpendCaps
  runStartAt: string
  reading: { sevenDay: number; fiveHour: number; ageSeconds: number }
  history: { at: string; sevenDay: number; resetsAt?: string }[]
}

// Run spend 107 against per_run_points 60, on seven_day 19 of pool workout (reserve 10).
const FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ticks-2026-10-11T2343Z.json'),
    'utf8',
  ),
) as Fixture
const NOW = new Date(FIXTURE.now)
const DAY = 86_400_000
const REPO = '/tmp/repos/alpha-app'
const IDS = ['A-3', 'A-4']

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

const row = (id: string, score: number): ScoreRow =>
  ({
    id,
    initiative: 'alpha',
    score,
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

/** The pace controller's caps with the window resetting `days` from now: 2 puts the glide near 82, far above 19. */
const shadowResetting = (days: number): ShadowCaps => ({
  pool: FIXTURE.pool,
  spend: {},
  pace: { reserve: 10, resetsAt: NOW.getTime() + days * DAY },
})

function plan(shadow?: ShadowCaps): SeatPlan {
  return planSeat({
    seat: SEAT,
    rows: IDS.map((id, i) => row(id, 70 - i)),
    defaults: { initiative_decay: 0.5, share_caps: {} } as unknown as ScoringDefaults,
    tasks: new Map([['alpha', IDS.map(task)]]),
    ledger: EMPTY_LEDGER,
    budget: {
      pool: FIXTURE.pool,
      spend: FIXTURE.spend,
      reading: FIXTURE.reading,
      history: FIXTURE.history.map(s => ({
        at: Date.parse(s.at),
        sevenDay: s.sevenDay,
        ...(s.resetsAt === undefined ? {} : { resetsAt: Date.parse(s.resetsAt) }),
      })),
      runStartAt: Date.parse(FIXTURE.runStartAt),
      ctx: { now: NOW },
      ...(shadow === undefined ? {} : { shadow }),
    },
  })
}

function rowOf(planned: SeatPlan) {
  const outcome = {
    seat: FIXTURE.seat,
    dispatched: planned.dispatch.length,
    refusals: planned.refusals,
    roles: planned.roles,
    ...(planned.pace === undefined ? {} : { pace: planned.pace }),
  }
  const inputs = {
    now: NOW,
    maxAgeDays: 14,
    caps: { [FIXTURE.seat]: SEAT.caps },
    outcomes: [outcome],
    dispatch: planned.dispatch,
    tasks: new Map(),
    registrations: [],
  }
  return tickSummary(inputs).seats[FIXTURE.seat]
}

describe('a seat past per_run_points while its pool is behind the glide', () => {
  it('logs legacy refusing on per_run and pace admitting, and dispatches nothing', () => {
    const seat = rowOf(plan(shadowResetting(2)))

    expect(seat?.dispatched).toBe(0)
    expect(seat?.pace).toMatchObject({
      mode: 'shadow',
      legacy: { open: false, lever: 'spend.per_run_points', value: 60, reading: 107 },
      pace: { open: true, lever: 'pace', reading: 19 },
      agree: false,
    })
  })
})

describe('a seat whose pool is ahead of the glide early in the week', () => {
  it('logs both refusing as an agreement', () => {
    const seat = rowOf(plan(shadowResetting(6.9)))

    expect(seat?.pace).toMatchObject({
      legacy: { open: false, lever: 'spend.per_run_points' },
      pace: { open: false, lever: 'pace', reading: 19 },
      agree: true,
    })
  })
})

describe('a tick without shadow caps', () => {
  it('carries no pace on the seat row', () => {
    expect(rowOf(plan())).not.toHaveProperty('pace')
  })
})
