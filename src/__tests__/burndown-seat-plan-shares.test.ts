import { describe, expect, it } from 'vitest'
import type { PoolGateInput } from '../agents/burndown/budget-gate.js'
import type { Task } from '../agents/burndown/eligibility.js'
import { EMPTY_LEDGER, type Claim } from '../agents/burndown/ledger.js'
import type { ScoreRow, ScoringDefaults } from '../agents/burndown/score.js'
import type { SeatDispatch } from '../agents/burndown/seat-dispatch.js'
import { planSeat, type SeatPlanInputs } from '../agents/burndown/seat-plan.js'

/** CC-1107 b: planSeat orders whole-task picks by project share when `shares` is set. */

const NOW = new Date('2026-09-29T12:00:00.000Z')
const RUN_START = Date.parse('2026-09-29T08:00:00.000Z')
const FRESH = 'brief:ready=2026-09-28'

const SEAT: SeatDispatch = {
  seat: 'seat-a',
  prefix: 'sa',
  pool: { name: 'pool-x', human_uses: false, reserve_seven_day: 20, ceiling_five_hour: 80 },
  configDir: '/tmp/pool-x',
  repos: { alpha: ['/tmp/repos/alpha-app'], beta: ['/tmp/repos/beta'] },
  caps: { implementers: 5, reviewers: 1, planners: 1 },
  worktrees: { perRepoPerSeat: 10, capName: 'worktrees_per_repo_per_seat', leftFreePerRepo: 2 },
  excludedTags: [],
  grants: [],
}

const DEFAULTS = { initiative_decay: 0.5, share_caps: {} } as unknown as ScoringDefaults

const row = (id: string, initiative: string, score: number): ScoreRow =>
  ({
    id,
    initiative,
    score,
    kind: 'platform',
    blocked: [],
    stopShort: [],
    route: 'implementer',
    components: { W: 1 },
  }) as ScoreRow

const task = (id: string): Task => ({
  id,
  title: `task ${id}`,
  status: 'open',
  priority: 1,
  estimate: 2,
  doneWhen: 'The widget renders.',
  tags: [FRESH],
})

const pool: PoolGateInput = {
  pool: SEAT.pool,
  spend: {},
  reading: { sevenDay: 40, fiveHour: 10, ageSeconds: 30 },
  history: [],
  runStartAt: RUN_START,
  ctx: { now: NOW },
}

const doneClaim = (taskId: string, initiative: string): Claim => ({
  taskId,
  initiative,
  seat: 'seat-a',
  namePrefix: 'sa',
  spawnedAt: '2026-09-29T09:00:00.000Z',
  phase: 'done',
  phaseAt: '2026-09-29T09:00:00.000Z',
})

/** Five rows per project; beta's score higher, so the legacy order favours beta. */
function twoProjects(patch: Partial<SeatPlanInputs> = {}): SeatPlanInputs {
  const ids = (prefix: string) => [1, 2, 3, 4, 5].map(n => `${prefix}-${n}`)
  const rows = [
    ...ids('A').map((id, i) => row(id, 'alpha', 50 - i)),
    ...ids('B').map((id, i) => row(id, 'beta', 90 - i)),
  ]
  const tasks = new Map([
    ['alpha', ids('A').map(task)],
    ['beta', ids('B').map(task)],
  ])
  return { seat: SEAT, rows, defaults: DEFAULTS, tasks, ledger: EMPTY_LEDGER, budget: pool, ...patch }
}

const SHARES = { initiatives: { alpha: 0.8, beta: 0.2 } }
const GATE_ON = { gate: 'on', maxAgeDays: 14 } as const
const byProject = (plan: ReturnType<typeof planSeat>) =>
  plan.dispatch.reduce<Record<string, number>>(
    (mix, d) => ({ ...mix, [d.initiative]: (mix[d.initiative] ?? 0) + 1 }),
    {},
  )

describe('planSeat with project shares (CC-1107)', () => {
  it('without shares keeps the legacy decayed order and records no mix', () => {
    const plan = planSeat(twoProjects())

    expect(plan.dispatch.map(d => d.task)).toEqual(['B-1', 'A-1', 'B-2', 'A-2', 'B-3'])
    expect(plan.shareMix).toBeUndefined()
  })

  it('under an on gate dispatches 4 of 5 from the 0.8 project', () => {
    const plan = planSeat(twoProjects({ brief: GATE_ON, shares: SHARES }))

    expect(plan.dispatch.map(d => d.task)).toEqual(['A-1', 'A-2', 'B-1', 'A-3', 'A-4'])
    expect(byProject(plan)).toEqual({ alpha: 4, beta: 1 })
  })

  it('under an on gate without shares keeps the ready order', () => {
    const plan = planSeat(twoProjects({ brief: GATE_ON }))

    expect(byProject(plan)).toEqual({ beta: 5 })
  })

  it('counts the run prior picks toward the share, so a picked-ahead project waits', () => {
    const ledger = {
      ...EMPTY_LEDGER,
      claims: ['A-8', 'A-9', 'A-10', 'A-11'].map(id => doneClaim(id, 'alpha')),
    }
    const shares = { initiatives: { alpha: 0.5, beta: 0.5 } }

    const plan = planSeat(twoProjects({ brief: GATE_ON, shares, ledger }))

    expect(plan.dispatch.map(d => d.task).slice(0, 4)).toEqual(['B-1', 'B-2', 'B-3', 'B-4'])
  })

  it('reports each project share and its picks with prior picks included', () => {
    const ledger = { ...EMPTY_LEDGER, claims: [doneClaim('B-9', 'beta'), doneClaim('C-1', 'gamma')] }

    const plan = planSeat(twoProjects({ brief: GATE_ON, shares: SHARES, ledger }))

    expect(plan.shareMix).toEqual({
      alpha: { share: 0.8, picks: 5 },
      beta: { share: 0.2, picks: 1 },
      gamma: { share: 0, picks: 1 },
    })
  })
})
