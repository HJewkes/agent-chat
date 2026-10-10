import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { advance, applyActions, claimKey, type Action } from '../agents/burndown/advance.js'
import type { PoolGateInput } from '../agents/burndown/budget-gate.js'
import type { Task } from '../agents/burndown/eligibility.js'
import { EMPTY_LEDGER, readySlices, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { readSlices } from '../agents/burndown/report.js'
import type { ScoreRow, ScoringDefaults } from '../agents/burndown/score.js'
import type { SeatDispatch } from '../agents/burndown/seat-dispatch.js'
import { planSeat, type SeatPlanInputs } from '../agents/burndown/seat-plan.js'
import { diskPlanReader, seedSteps, type PlanReader } from '../agents/burndown/seed-slices.js'

/** CC-927: a seat-written plan's slices are queued in place of a planner under an `on` brief gate. */

const NOW = new Date('2026-09-29T12:00:00.000Z')
const REPO = '/tmp/repos/alpha-app'
const PLAN_PATH = '/tmp/aw/alpha/sources/A-1-plan.md'
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

const SLICES = [
  {
    n: 'a',
    title: 'ledger',
    dependsOn: [],
    owns: ['src/ledger.ts'],
    points: 2,
    doneWhen: 'Ledger test passes.',
    contracts: [{ scope: 'api:/v1/ledger', op: 'add' }],
  },
  {
    n: 'b',
    title: 'tick',
    dependsOn: ['a'],
    owns: ['src/tick.ts'],
    points: 1,
    doneWhen: 'Tick test passes.',
  },
]

const planText = (slices: unknown): string =>
  `# Plan\n\nProse the seat wrote.\n\n\`\`\`burndown-slices\n${JSON.stringify(slices)}\n\`\`\`\n`

const task = (patch: Partial<Task> = {}): Task => ({
  id: 'A-1',
  title: 'task A-1',
  status: 'open',
  priority: 1,
  estimate: 5,
  doneWhen: 'The widget renders.',
  tags: [FRESH],
  ...patch,
})

const row = (route: ScoreRow['route'] = 'planner'): ScoreRow =>
  ({
    id: 'A-1',
    initiative: 'alpha',
    score: 50,
    kind: 'platform',
    blocked: [],
    stopShort: [],
    route,
    components: { W: 1 },
  }) as unknown as ScoreRow

const pool: PoolGateInput = {
  pool: SEAT.pool,
  spend: {},
  reading: { sevenDay: 40, fiveHour: 10, ageSeconds: 30 },
  history: [],
  runStartAt: Date.parse('2026-09-29T08:00:00.000Z'),
  ctx: { now: NOW },
}

const reader = (text: string | undefined) => vi.fn<PlanReader>(() => ({ path: PLAN_PATH, text }))

const ON = { brief: { gate: 'on' as const, maxAgeDays: 14 } }

function plan(patch: Partial<SeatPlanInputs> & { t?: Partial<Task>; route?: ScoreRow['route'] } = {}) {
  const { t, route, ...rest } = patch
  return planSeat({
    seat: SEAT,
    rows: [row(route)],
    defaults: { initiative_decay: 0.5, share_caps: {} } as unknown as ScoringDefaults,
    tasks: new Map([['alpha', [task(t)]]]),
    ledger: EMPTY_LEDGER,
    budget: pool,
    ...rest,
  })
}

/** What the planner path queues for the same slices: a planner claim of this seat exiting with them. */
function plannerSlices(): Claim[] {
  const planner: Claim = {
    taskId: 'A-1',
    initiative: 'alpha',
    seat: 'seat-a',
    namePrefix: 'sa',
    spawnedAt: '2026-09-29T09:00:00.000Z',
    phase: 'planning',
    phaseAt: '2026-09-29T09:00:00.000Z',
    agentName: 'sa-a-1',
  }
  const slices = readSlices(planText(SLICES)).slices
  const observed = new Map([[claimKey(planner), { agent: { state: 'exited' as const }, slices }]])
  const added = advance([planner], observed as never, NOW).find(a => a.kind === 'add')
  return added?.kind === 'add' ? added.claims : []
}

describe('seeding slices from a seat-written plan (CC-927)', () => {
  it('queues the plan slices with owns, contracts and dependsOn and spawns no planner', () => {
    const result = plan({ ...ON, readPlan: reader(planText(SLICES)) })

    expect(result.dispatch).toEqual([])
    expect(result.refusals).toEqual([])
    expect(result.seeds.map(c => [c.slice, c.phase, c.dependsOn, c.owns, c.contracts])).toEqual([
      ['a', 'queued', [], ['src/ledger.ts'], [{ scope: 'api:/v1/ledger', op: 'add' }]],
      ['b', 'queued', ['a'], ['src/tick.ts'], undefined],
    ])
    expect(result.notes).toEqual([`seeded alpha A-1 slices a, b from ${PLAN_PATH} (seat seat-a)`])
  })

  it("queues exactly the claims a planner's report would", () => {
    const result = plan({ ...ON, readPlan: reader(planText(SLICES)) })

    expect(result.seeds).toEqual(plannerSlices())
  })

  it('refuses a plan that fails the lint as plan-blocked, naming the problem', () => {
    const bad = [SLICES[0], { ...SLICES[1], owns: [] }]

    const result = plan({ ...ON, readPlan: reader(planText(bad)) })

    expect(result.dispatch).toEqual([])
    expect(result.seeds).toEqual([])
    expect(result.refusals).toEqual([
      {
        initiative: 'alpha',
        task: 'A-1',
        kind: 'plan-blocked',
        reason: `${PLAN_PATH}: slice b: owns no files`,
      },
    ])
  })

  it('refuses a plan file with no slices block rather than planning over it', () => {
    const result = plan({ ...ON, readPlan: reader('# Plan\n\nProse only.\n') })

    expect(result.dispatch).toEqual([])
    expect(result.refusals.map(r => [r.kind, r.reason])).toEqual([
      ['plan-blocked', `${PLAN_PATH}: plan has no burndown-slices block`],
    ])
  })

  it('keeps the planner path when the task has no plan file', () => {
    const result = plan({ ...ON, readPlan: reader(undefined) })

    expect(result.seeds).toEqual([])
    expect(result.dispatch.map(d => [d.task, d.profile])).toEqual([['A-1', 'bd-planner']])
  })

  it('does not seed a task whose slices already ran', () => {
    const done = plannerSlices().map(c => ({ ...c, phase: 'done' as const }))
    const ledger: Ledger = { ...EMPTY_LEDGER, claims: done }

    const result = plan({ ...ON, ledger, readPlan: reader(planText(SLICES)) })

    expect(result.seeds).toEqual([])
    expect(result.refusals.map(r => r.kind)).toEqual(['plan-blocked'])
  })

  it('reads no plan and dispatches the planner when the gate is off or shadow', () => {
    for (const brief of [undefined, { gate: 'shadow' as const, maxAgeDays: 14 }]) {
      const readPlan = reader(planText(SLICES))

      const result = plan({ ...(brief === undefined ? {} : { brief }), readPlan })

      expect(readPlan).not.toHaveBeenCalled()
      expect(result.seeds).toEqual([])
      expect(result.dispatch.map(d => [d.task, d.profile])).toEqual([['A-1', 'bd-planner']])
    }
  })

  it('reads no plan for a task routed to an implementer', () => {
    const readPlan = reader(planText(SLICES))

    const result = plan({ ...ON, readPlan, route: 'implementer', t: { estimate: 2 } })

    expect(readPlan).not.toHaveBeenCalled()
    expect(result.dispatch.map(d => d.profile)).toEqual(['bd-implementer'])
  })

  it('refuses an unbriefed task under on before reading its plan', () => {
    const readPlan = reader(planText(SLICES))

    const result = plan({ ...ON, readPlan, t: { tags: [] } })

    expect(readPlan).not.toHaveBeenCalled()
    expect(result.refusals.map(r => r.kind)).toEqual(['no-brief'])
  })
})

describe('seedSteps', () => {
  it('adds no step when nothing was seeded', () => {
    expect(seedSteps([])).toEqual([])
    expect(seedSteps(undefined)).toEqual([])
  })

  it('adds the seeds to the ledger, where the slice with no dependency is ready', () => {
    const seeds = plan({ ...ON, readPlan: reader(planText(SLICES)) }).seeds

    const [step] = seedSteps(seeds)
    const actions: Action[] = step?.kind === 'ledger' ? step.actions : []
    const ledger = applyActions(EMPTY_LEDGER, actions, NOW)

    expect(readySlices(ledger).map(c => c.slice)).toEqual(['a'])
  })
})

describe('diskPlanReader', () => {
  it("reads the initiative's sources/<ID>-plan.md, and no text when it is absent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-slices-'))
    fs.mkdirSync(path.join(root, 'alpha', 'sources'), { recursive: true })
    fs.writeFileSync(path.join(root, 'alpha', 'sources', 'A-1-plan.md'), 'plan text')

    const read = diskPlanReader(root)

    expect(read('alpha', 'A-1')).toEqual({ path: `${root}/alpha/sources/A-1-plan.md`, text: 'plan text' })
    expect(read('alpha', 'A-2').text).toBeUndefined()
    fs.rmSync(root, { recursive: true, force: true })
  })
})
