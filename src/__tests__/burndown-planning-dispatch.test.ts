import { describe, expect, it } from 'vitest'
import { advance, claimKey, type Action } from '../agents/burndown/advance.js'
import type { PoolGateInput } from '../agents/burndown/budget-gate.js'
import type { Task } from '../agents/burndown/eligibility.js'
import { EMPTY_LEDGER, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { readSlices } from '../agents/burndown/report.js'
import type { ScoreRow, ScoringDefaults } from '../agents/burndown/score.js'
import type { SeatDispatch } from '../agents/burndown/seat-dispatch.js'
import { planSeat, type SeatPlanInputs } from '../agents/burndown/seat-plan.js'
import { seedSlices } from '../agents/burndown/seed-slices.js'

/** CC-986 slice a: a brief:ready task with no plan is dispatched to a planner, not refused no-owns. */

const NOW = new Date('2026-09-29T12:00:00.000Z')
const REPO = '/tmp/repos/alpha-app'
const PLAN = '/tmp/alpha/sources/A-1-plan.md'
const FRESH = 'brief:ready=2026-09-28'

const SEAT: SeatDispatch = {
  seat: 'seat-a',
  prefix: 'sa',
  pool: { name: 'pool-x', human_uses: false, reserve_seven_day: 20, ceiling_five_hour: 80 },
  configDir: '/tmp/pool-x',
  repos: { alpha: [REPO] },
  caps: { implementers: 2, reviewers: 1, planners: 1 },
  worktrees: { perRepoPerSeat: 3, capName: 'worktrees_per_repo_per_seat', leftFreePerRepo: 2 },
  excludedTags: [],
  grants: [],
}

const POOL: PoolGateInput = {
  pool: SEAT.pool,
  spend: {},
  reading: { sevenDay: 40, fiveHour: 10, ageSeconds: 30 },
  history: [],
  runStartAt: Date.parse('2026-09-29T08:00:00.000Z'),
  ctx: { now: NOW },
}

const ROW = {
  id: 'A-1',
  initiative: 'alpha',
  score: 50,
  kind: 'platform',
  blocked: [],
  stopShort: [],
  route: 'implementer',
  components: { W: 1 },
} as unknown as ScoreRow

const TASK: Task = {
  id: 'A-1',
  title: 'task A-1',
  status: 'open',
  priority: 1,
  estimate: 2,
  doneWhen: 'The widget renders.',
  tags: [FRESH],
}

const SLICE = { n: 'a', title: 'x', points: 2, doneWhen: 'x renders.', dependsOn: [], owns: ['src/x.ts'] }
const PLAN_TEXT = '```burndown-slices\n' + JSON.stringify([SLICE]) + '\n```\n'

const plan = (text: string | undefined, patch: Partial<SeatPlanInputs> = {}) =>
  planSeat({
    seat: SEAT,
    rows: [ROW],
    defaults: { initiative_decay: 0.5, share_caps: {} } as unknown as ScoringDefaults,
    tasks: new Map([['alpha', [TASK]]]),
    ledger: EMPTY_LEDGER,
    budget: POOL,
    brief: { gate: 'on', maxAgeDays: 14 },
    readPlan: () => ({ path: PLAN, text }),
    ...patch,
  })

/** The planning claim the tick writes for the plan's one dispatch. */
function plannerClaim(): Claim {
  const [d] = plan(undefined).dispatch
  return {
    taskId: 'A-1',
    initiative: 'alpha',
    seat: d?.seat,
    namePrefix: d?.namePrefix,
    agentName: d?.agentName,
    spawnedAt: NOW.toISOString(),
    phase: 'planning',
    phaseAt: NOW.toISOString(),
  }
}

const exited = (claim: Claim, extra: object) =>
  new Map([[claimKey(claim), { agent: { id: 'p', state: 'exited' as const }, ...extra }]])

describe('planSeat sends a brief:ready task with no plan to a planner (CC-986)', () => {
  it('dispatches one planner for the task with a planning note, and refuses nothing', () => {
    const planned = plan(undefined)

    expect(planned.dispatch).toEqual([
      expect.objectContaining({ task: 'A-1', profile: 'bd-planner', cwd: REPO, agentName: 'sa-a-1' }),
    ])
    expect(planned.dispatch[0]?.worktree).toBeUndefined()
    expect(planned.refusals).toEqual([])
    expect(planned.notes).toEqual([`planning alpha A-1: no plan at ${PLAN} (seat seat-a)`])
    expect(planned.roles).toMatchObject({ planners: 1, implementers: 0 })
  })

  it('refuses role-cap when the seat already holds its planners cap', () => {
    const ledger: Ledger = {
      ...EMPTY_LEDGER,
      claims: [{ ...plannerClaim(), taskId: 'A-9', agentName: 'sa-a-9' }],
    }

    const planned = plan(undefined, { ledger })

    expect(planned.dispatch).toEqual([])
    expect(planned.refusals.map(r => [r.task, r.kind])).toEqual([['A-1', 'role-cap']])
    expect(planned.refusals[0]?.reason).toMatch(/holds 1 of 1 planners/)
  })

  it("seeds the planner's slices as the same claims seedSlices makes from the plan", () => {
    const claim = plannerClaim()
    const { slices } = readSlices(PLAN_TEXT)

    const actions = advance([claim], exited(claim, { slices }), NOW)

    const seeded = seedSlices(claim, { path: PLAN, text: PLAN_TEXT }, EMPTY_LEDGER, NOW)
    expect(seeded).toBeDefined()
    expect(actions).toContainEqual({ kind: 'add', claims: seeded && 'claims' in seeded ? seeded.claims : [] })
  })

  it('stalls a planner with no valid slices as planner-refused, and the next plan dispatches nothing for it', () => {
    const claim = plannerClaim()

    const actions = advance([claim], exited(claim, { sliceProblems: ['no burndown-slices block'] }), NOW)

    const stalled = applyUpdates(claim, actions)
    expect(stalled.stallCode).toBe('planner-refused')
    const next = plan(undefined, { ledger: { ...EMPTY_LEDGER, claims: [stalled] } })
    expect(next.dispatch).toEqual([])
    expect(next.refusals.map(r => [r.task, r.kind])).toEqual([['A-1', 'claimed']])
  })

  it('blocks a plan that fails the lint as plan-blocked, with no planner over two plans', () => {
    const broken = '```burndown-slices\nnot json\n```\n'

    const plans = [plan(broken), plan(broken)]

    for (const planned of plans) {
      expect(planned.dispatch).toEqual([])
      expect(planned.refusals.map(r => [r.task, r.kind])).toEqual([['A-1', 'plan-blocked']])
    }
  })
})

function applyUpdates(claim: Claim, actions: Action[]): Claim {
  return actions.reduce<Claim>((c, a) => (a.kind === 'update' ? ({ ...c, ...a.patch } as Claim) : c), claim)
}
