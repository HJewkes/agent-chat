import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PoolGateInput } from '../agents/burndown/budget-gate.js'
import type { Task } from '../agents/burndown/eligibility.js'
import { EMPTY_LEDGER, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import type { Dispatch } from '../agents/burndown/plan.js'
import type { PriorRouter } from '../agents/burndown/prior-route.js'
import type { ScoreRow, ScoringDefaults } from '../agents/burndown/score.js'
import type { SeatDispatch } from '../agents/burndown/seat-dispatch.js'
import { planSeat, type SeatPlanInputs } from '../agents/burndown/seat-plan.js'
import { loadSeats, planSeats, type SeatTickDeps } from '../agents/burndown/seat-tick.js'
import type { PlanReader } from '../agents/burndown/seed-slices.js'
import { readInitiatives } from '../agents/burndown/source.js'
import { parseWorkflowTable, workflowTablePath } from '../agents/burndown/workflow-table.js'

/** CC-638 slice b: planSeat routes implementer task rows and queued slices by prior behind priorRouting. */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TABLE_TEXT = fs.readFileSync(path.join(HERE, '..', '..', 'docs', 'workflow', 'shape-v1.yml'), 'utf8')
const table = parseWorkflowTable(TABLE_TEXT).table!
const ON: PriorRouter = { mode: 'on', table }
const SHADOW: PriorRouter = { mode: 'shadow', table }

const NOW = new Date('2026-09-29T12:00:00.000Z')
const RUN_START = Date.parse('2026-09-29T08:00:00.000Z')
const REPO = '/tmp/repos/alpha-app'

const SEAT: SeatDispatch = {
  seat: 'seat-a',
  prefix: 'sa',
  pool: { name: 'pool-x', human_uses: false, reserve_seven_day: 20, ceiling_five_hour: 80 },
  configDir: '/tmp/pool-x',
  repos: { alpha: [REPO] },
  caps: { implementers: 6, reviewers: 1, planners: 1 },
  worktrees: { perRepoPerSeat: 6, capName: 'worktrees_per_repo_per_seat', leftFreePerRepo: 0 },
  excludedTags: [],
  grants: [],
}

const DEFAULTS = { initiative_decay: 0.5, share_caps: {} } as unknown as ScoringDefaults

const row = (id: string, score: number, patch: Partial<ScoreRow> = {}): ScoreRow =>
  ({
    id,
    initiative: 'alpha',
    score,
    kind: 'platform',
    blocked: [],
    stopShort: [],
    route: 'implementer',
    components: { W: 1 },
    ...patch,
  }) as ScoreRow

const task = (id: string, patch: Partial<Task> = {}): Task => ({
  id,
  title: `task ${id}`,
  status: 'open',
  priority: 1,
  estimate: 2,
  doneWhen: 'The widget renders.',
  tags: [],
  ...patch,
})

const openPool = (reading = { sevenDay: 40, fiveHour: 10, ageSeconds: 30 }): PoolGateInput => ({
  pool: SEAT.pool,
  spend: {},
  reading,
  history: [],
  runStartAt: RUN_START,
  ctx: { now: NOW },
})

const claim = (taskId: string, patch: Partial<Claim> = {}): Claim => ({
  taskId,
  initiative: 'alpha',
  seat: 'seat-a',
  namePrefix: 'sa',
  spawnedAt: '2026-09-29T09:00:00.000Z',
  phase: 'implementing',
  phaseAt: '2026-09-29T09:00:00.000Z',
  ...patch,
})

const queued = (taskId: string, slice: string, owns: string[]): Claim =>
  claim(taskId, { phase: 'queued', slice, owns })

/** A plan whose slice `b` is 2 points and slice `c` is 1, as `diskPlanReader` would read it. */
const PLAN_TEXT = [
  '```burndown-slices',
  JSON.stringify([
    { n: 'b', title: 'two', doneWhen: 'b ships', points: 2, dependsOn: [], owns: ['src/agents/x.ts'] },
    { n: 'c', title: 'one', doneWhen: 'c ships', points: 1, dependsOn: [], owns: ['src/broker/x.ts'] },
  ]),
  '```',
  '',
].join('\n')
const readPlan: PlanReader = (_, taskId) => ({
  path: `/plans/${taskId}.md`,
  text: taskId === 'P-1' ? PLAN_TEXT : undefined,
})

function inputs(rows: ScoreRow[], tasks: Task[], patch: Partial<SeatPlanInputs> = {}): SeatPlanInputs {
  return {
    seat: SEAT,
    rows,
    defaults: DEFAULTS,
    tasks: new Map([['alpha', tasks]]),
    ledger: EMPTY_LEDGER,
    budget: openPool(),
    readPlan,
    ...patch,
  }
}

const profiles = (dispatch: readonly Dispatch[]) => dispatch.map(d => [d.slice ?? d.task, d.profile])

const SECURITY = task('S-1', { estimate: 1, tags: ['kind:security'] })
const FEATURE = task('F-1', { estimate: 2, tags: ['kind:feature'] })
const MIXED_ROWS = [row('S-1', 60, { route: 'implementer-lite' }), row('F-1', 50)]

describe('planSeat with priorRouter on', () => {
  it('dispatches a kind:security estimate-1 row as bd-implementer and a kind:feature estimate-2 row as lite', () => {
    const plan = planSeat(inputs(MIXED_ROWS, [SECURITY, FEATURE], { priorRouter: ON }))

    expect(profiles(plan.dispatch)).toEqual([
      ['S-1', 'bd-implementer'],
      ['F-1', 'bd-implementer-lite'],
    ])
    expect(plan.notes).toEqual([
      expect.stringMatching(
        /^route-change alpha S-1 \(seat seat-a\): bd-implementer-lite -> bd-implementer \(prior safety-path/,
      ),
      expect.stringMatching(
        /^route-change alpha F-1 \(seat seat-a\): bd-implementer -> bd-implementer-lite \(prior standard/,
      ),
    ])
  })

  it('dispatches a 2-point slice with no risk-path owns as lite and keeps a broker slice on bd-implementer', () => {
    const ledger: Ledger = {
      ...EMPTY_LEDGER,
      claims: [queued('P-1', 'b', ['src/agents/x.ts']), queued('P-1', 'c', ['src/broker/x.ts'])],
    }

    const plan = planSeat(inputs([], [task('P-1', { estimate: 3 })], { ledger, priorRouter: ON }))

    expect(profiles(plan.dispatch)).toEqual([
      ['b', 'bd-implementer-lite'],
      ['c', 'bd-implementer'],
    ])
    expect(plan.notes).toEqual([
      expect.stringMatching(
        /^route-change alpha P-1 slice b \(seat seat-a\): bd-implementer -> bd-implementer-lite/,
      ),
    ])
  })

  it('leaves planner and briefer rows on the planner profile', () => {
    const rows = [row('PL-1', 60, { route: 'planner' }), row('BR-1', 50, { route: 'briefer' })]
    const tasks = [task('PL-1', { estimate: 1 }), task('BR-1', { estimate: 1, tags: ['brief:wanted'] })]
    const seat = { ...SEAT, caps: { ...SEAT.caps, planners: 2 } }

    const plan = planSeat(inputs(rows, tasks, { seat, priorRouter: ON }))

    expect(profiles(plan.dispatch)).toEqual([
      ['PL-1', 'bd-planner'],
      ['BR-1', 'bd-planner'],
    ])
    expect(plan.notes).toEqual([])
  })

  it('refuses a row routed up to opus with kind budget under a sonnet-only pool', () => {
    const budget = openPool({ sevenDay: 75, fiveHour: 10, ageSeconds: 30 })

    const plan = planSeat(inputs(MIXED_ROWS, [SECURITY, FEATURE], { budget, priorRouter: ON }))

    expect(profiles(plan.dispatch)).toEqual([['F-1', 'bd-implementer-lite']])
    expect(plan.refusals).toEqual([
      expect.objectContaining({
        task: 'S-1',
        kind: 'budget',
        reason: expect.stringContaining('bd-implementer'),
      }),
    ])
    expect(plan.notes.filter(n => n.includes('S-1'))).toEqual([])
  })
})

describe('planSeat without priorRouter on', () => {
  it("dispatches by today's route with no notes when the router is absent", () => {
    const plan = planSeat(inputs(MIXED_ROWS, [SECURITY, FEATURE]))

    expect(profiles(plan.dispatch)).toEqual([
      ['S-1', 'bd-implementer-lite'],
      ['F-1', 'bd-implementer'],
    ])
    expect(plan.notes).toEqual([])
  })

  it('reads no plan when the router is absent', () => {
    const read: string[] = []
    const counting: PlanReader = (initiative, taskId) => {
      read.push(taskId)
      return readPlan(initiative, taskId)
    }
    const ledger: Ledger = { ...EMPTY_LEDGER, claims: [queued('P-1', 'b', ['src/agents/x.ts'])] }

    planSeat(inputs(MIXED_ROWS, [SECURITY, FEATURE, task('P-1')], { ledger, readPlan: counting }))

    expect(read).toEqual([])
  })

  it('in shadow mode dispatches exactly as with no router and notes would-route', () => {
    const ledger: Ledger = { ...EMPTY_LEDGER, claims: [queued('P-1', 'b', ['src/agents/x.ts'])] }
    const tasks = [SECURITY, FEATURE, task('P-1')]
    const today = planSeat(inputs(MIXED_ROWS, tasks, { ledger }))

    const shadow = planSeat(inputs(MIXED_ROWS, tasks, { ledger, priorRouter: SHADOW }))

    expect({ ...shadow, notes: [] }).toEqual(today)
    expect(shadow.notes).toEqual([
      expect.stringMatching(/^would-route alpha P-1 slice b /),
      expect.stringMatching(/^would-route alpha S-1 /),
      expect.stringMatching(/^would-route alpha F-1 /),
    ])
  })
})

describe('route-change notes over three successive ticks', () => {
  /** Each tick holds the previous ticks' dispatches as claims and adds one new task. */
  const TICKS: { row: ScoreRow; task: Task; today: string }[] = [
    { row: row('F-1', 50), task: FEATURE, today: 'bd-implementer' },
    { row: row('S-1', 60, { route: 'implementer-lite' }), task: SECURITY, today: 'bd-implementer-lite' },
    {
      row: row('S-2', 40),
      task: task('S-2', { estimate: 1, tags: ['kind:security'] }),
      today: 'bd-implementer',
    },
  ]

  it('lists one route-change line per dispatch whose profile differs from today and none for the rest', () => {
    const held: Claim[] = []
    const perTick: { dispatched: string[]; changed: string[]; notes: string[] }[] = []
    for (let n = 1; n <= TICKS.length; n += 1) {
      const live = TICKS.slice(0, n)
      const ledger: Ledger = { ...EMPTY_LEDGER, claims: [...held] }
      const plan = planSeat(
        inputs(
          live.map(t => t.row),
          live.map(t => t.task),
          { ledger, priorRouter: ON },
        ),
      )
      const changed = plan.dispatch
        .filter(d => d.profile !== TICKS.find(t => t.task.id === d.task)!.today)
        .map(d => d.task)
      perTick.push({ dispatched: plan.dispatch.map(d => d.task), changed, notes: plan.notes })
      held.push(...plan.dispatch.map(d => claim(d.task, { agentName: d.agentName })))
    }

    expect(perTick.map(t => t.dispatched)).toEqual([['F-1'], ['S-1'], ['S-2']])
    expect(perTick.map(t => t.changed)).toEqual([['F-1'], ['S-1'], []])
    for (const { changed, notes } of perTick) {
      expect(notes.filter(n => n.startsWith('route-change'))).toHaveLength(changed.length)
      for (const id of changed) expect(notes.filter(n => n.includes(` ${id} `))).toHaveLength(1)
    }
  })
})

describe('planSeats reading the workflow table', () => {
  const AUTONOMY = path.join(HERE, 'fixtures', 'autonomy-2026-09-29')
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-seat-plan-prior-'))
    fs.cpSync(AUTONOMY, root, { recursive: true })
    fs.mkdirSync(path.join(root, 'init-alpha', 'tasks'), { recursive: true })
    fs.writeFileSync(path.join(root, 'init-alpha', 'brief.md'), '---\nstate: active\nrank: 1\n---\n')
    fs.writeFileSync(
      path.join(root, 'init-alpha', 'tasks', 'AA-1.yml'),
      'id: AA-1\ntitle: task AA-1\npriority: 3\nseverity: high\nestimate: 2\n' +
        "done_when: The widget renders.\nstatus: open\ntags: ['kind:feature']\nnotes: ''\n" +
        'created: 2026-09-01\nupdated: 2026-09-20\ndone_at: null\n',
    )
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  const NOW_LOCAL = new Date(2026, 8, 29, 10)
  const deps = (): SeatTickDeps => ({
    autonomyRoot: root,
    root,
    now: NOW_LOCAL,
    reading: () => ({ reading: { sevenDay: 40, fiveHour: 10, ageSeconds: 30 } }),
    meters: () => ({ run: { since: NOW_LOCAL.getTime() - 3_600_000, last: 40, spent: 0 } }),
  })

  const plan = (priorRouting: 'off' | 'shadow' | 'on') => {
    const runStart = NOW_LOCAL.getTime() - 3_600_000
    const samples = [
      { at: new Date(2026, 8, 29, 6).getTime(), sevenDay: 38 },
      { at: runStart, sevenDay: 39 },
    ]
    const ledger: Ledger = { ...EMPTY_LEDGER, seats: { 'seat-a': { configDir: '/tmp/pool-x', samples } } }
    const { loaded } = loadSeats(['seat-a'], ledger, deps())
    const brief = { briefGate: {}, briefMaxAgeDays: 14, maxAgents: 3, handReserve: {}, priorRouting }
    return planSeats(loaded, { ledger, initiatives: readInitiatives(root), scopeTagAliases: {}, brief }, root)
  }

  const writeTable = (text: string) => {
    const file = workflowTablePath(root)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }

  it('adds no note with priorRouting off and an invalid table in the autonomy root', () => {
    writeTable('version: shape-v1\nbogus: true\n')

    const planned = plan('off')

    expect(planned.refusals).toEqual([])
    expect(planned.notes.filter(n => n.includes('prior routing'))).toEqual([])
    expect(planned.dispatch.map(d => d.profile)).toEqual(['bd-implementer'])
  })

  it('notes the missing table with priorRouting on and routes as today', () => {
    const planned = plan('on')

    expect(planned.notes).toContain(
      `prior routing on: no workflow table at ${workflowTablePath(root)}; routing as today`,
    )
    expect(planned.dispatch.map(d => d.profile)).toEqual(['bd-implementer'])
  })

  it('routes by the installed table with priorRouting on', () => {
    writeTable(TABLE_TEXT)

    const planned = plan('on')

    expect(planned.dispatch.map(d => d.profile)).toEqual(['bd-implementer-lite'])
    expect(planned.notes).toEqual([expect.stringMatching(/^route-change init-alpha AA-1 \(seat seat-a\)/)])
  })
})
