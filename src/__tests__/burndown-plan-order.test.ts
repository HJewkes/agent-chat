import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { criticalPath } from '../agents/burndown/critical-path.js'
import { validateMilestones, type MilestoneFile } from '../agents/burndown/milestones.js'
import { planOrder, type PlannedRow, type PlanOrderInput } from '../agents/burndown/plan-order.js'
import { tasksFromList } from '../agents/burndown/score-source.js'
import { dispatchOrder, scoreAll, type ScoredTask, type ScoringDefaults } from '../agents/burndown/score.js'
import { parsePlanningTasks } from '../agents/burndown/task-tags.js'

/** CC-628: planOrder's tiers, its readiness rules, and its byte-for-byte match with dispatchOrder without planning tags. */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const readList = (dir: string) =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES, dir, 'tasks.json'), 'utf8')) as { today: string }

const DEFAULTS: ScoringDefaults = {
  kind_weights: { security: 1.0, product: 1.0, correctness: 0.9, platform: 0.8, docs: 0.5, nit: 0.35 },
  share_caps: { product: 0.2, docs: 0.1, nit: 0.1 },
  initiative_decay: 0.85,
  score_terms: { severity: 0.4, priority_pct: 0.3, unblocks: 0.2, staleness: 0.1 },
  severity: { critical: 1.0, high: 0.7, medium: 0.4, low: 0.15, unset: 0.3 },
  readiness: { ready: 1.0, untriaged: 0.6, blocked: 0.25 },
  size: { le3: 1.0, le8: 0.9, gt8: 0.75 },
  stop_short_factor: 0.8,
}
const WEIGHTS = {
  north: 1.0,
  south: 0.9,
  east: 0.8,
  west: 0.7,
  alpha: 1.0,
  beta: 0.8,
  gamma: 0.8,
  delta: 0.5,
  epsilon: 0.6,
}
const TODAY = '2026-10-03'

function inputFor(tasks: ScoredTask[], extra: Partial<PlanOrderInput> = {}): PlanOrderInput {
  const { rows } = scoreAll(tasks, WEIGHTS, DEFAULTS, { tags: [] }, [], extra.today ?? TODAY)
  return { rows, tasks, defaults: DEFAULTS, n: 10, today: TODAY, seat: 'sample-seat', ...extra }
}

const withoutPlanFields = ({ tier, wsjf, float, slack, milestone, ...row }: PlannedRow) => {
  expect({ tier, float, slack, milestone }).toEqual({
    tier: 3,
    float: undefined,
    slack: undefined,
    milestone: undefined,
  })
  expect(typeof wsjf === 'number' || row.estimate === null).toBe(true)
  return row
}

describe('planOrder without a milestone file or planning tags', () => {
  const synthetic = tasksFromList(readList('plan-order'))

  it('the synthetic backlog hits share caps and holds blocked rows, so the comparison is not vacuous', () => {
    const input = inputFor(synthetic)

    const today = dispatchOrder(input.rows, DEFAULTS, 10)

    expect(Object.keys(today.refused).length).toBeGreaterThan(0)
    expect(input.rows.filter(row => row.blocked.length > 0).length).toBeGreaterThan(1)
    expect(new Set(today.order.map(row => row.initiative)).size).toBe(4)
  })

  it.each([
    ['the synthetic backlog, top 10', 'plan-order', 10, {}],
    ['the synthetic backlog, top 4 after prior picks', 'plan-order', 4, { north: 2, east: 1 }],
    ['the synthetic backlog, every row', 'plan-order', 60, {}],
    ['the scorer parity backlog, top 20', 'score-2026-09-29', 20, {}],
  ])('%s matches dispatchOrder byte for byte', (_name, dir, n, priorPicks) => {
    const list = readList(dir)
    const input = inputFor(tasksFromList(list), { n, priorPicks, today: list.today })

    const planned = planOrder(input)
    const today = dispatchOrder(input.rows, DEFAULTS, n, priorPicks)

    expect(JSON.stringify(planned.order.map(withoutPlanFields))).toBe(JSON.stringify(today.order))
    expect(JSON.stringify(planned.refused)).toBe(JSON.stringify(today.refused))
  })

  it('a milestone file with no milestone tags in the backlog leaves the order unchanged', () => {
    const input = inputFor(synthetic)
    const milestones = milestoneFile([{ id: 'M1', rank: 1, seat: 'sample-seat' }])

    const planned = planOrder({ ...input, milestones })

    expect(JSON.stringify(planned.order.map(withoutPlanFields))).toBe(
      JSON.stringify(dispatchOrder(input.rows, DEFAULTS, 10).order),
    )
  })
})

function task(id: string, tags: string[] = [], fields: Partial<ScoredTask> = {}): ScoredTask {
  return {
    id,
    title: `Normalize the schema for ${id}`,
    priority: 3,
    severity: 'medium',
    estimate: 2,
    done_when: 'The change is merged.',
    tags,
    updated: '2026-09-20',
    slug: 'north',
    ...fields,
  }
}

type RawMilestone = { id: string; rank: number; seat: string; gated_by?: string; epics?: string[] }

function milestoneFile(milestones: RawMilestone[], done: string[] = []): MilestoneFile {
  const raw = { week: '2026-W40', appetite_days: 5, milestones }
  const { file, errors } = validateMilestones(
    raw,
    milestones.flatMap(m => m.epics ?? []),
    done,
  )
  expect(errors).toEqual([])
  return file!
}

const ids = (rows: readonly PlannedRow[]) => rows.map(row => row.id)
const tiers = (rows: readonly PlannedRow[]) => Object.fromEntries(rows.map(row => [row.id, row.tier]))

describe('planOrder tiers', () => {
  it('puts expedite first, oldest first, ahead of a higher-scored standard task', () => {
    const tasks = [
      task('EX-1', [], { severity: 'critical', priority: 1 }),
      task('EX-2', ['cos:expedite'], { updated: '2026-09-30' }),
      task('EX-3', ['cos:expedite'], { updated: '2026-09-01' }),
    ]

    const { order } = planOrder(inputFor(tasks))

    expect(ids(order)).toEqual(['EX-3', 'EX-2', 'EX-1'])
    expect(tiers(order)).toEqual({ 'EX-3': 0, 'EX-2': 0, 'EX-1': 3 })
  })

  it('takes a fixed-date task with under 2 days of slack, least slack first, and leaves a roomy one standard', () => {
    const tasks = [
      task('FX-1', ['cos:fixed', 'due:2026-10-05'], { estimate: 2 }),
      task('FX-2', ['cos:fixed', 'due:2026-10-05'], { estimate: 1 }),
      task('FX-3', ['cos:fixed', 'due:2026-10-30']),
    ]

    const { order } = planOrder(inputFor(tasks))

    expect(order.map(row => [row.id, row.tier, row.slack])).toEqual([
      ['FX-1', 1, 0],
      ['FX-2', 1, 1],
      ['FX-3', 3, undefined],
    ])
  })

  it('subtracts the remaining path in points from the days left', () => {
    const due = ['cos:fixed', 'due:2026-10-09']

    const { order } = planOrder(
      inputFor([task('FX-1', due, { estimate: 3 }), task('FX-2', due, { estimate: 5 })]),
    )

    expect(order.map(row => [row.id, row.tier, row.slack])).toEqual([
      ['FX-2', 1, 1],
      ['FX-1', 3, undefined],
    ])
  })

  it("orders the seat's milestones by rank, then total float, then WSJF, and leaves another seat's standard", () => {
    const tasks = [
      task('MS-1', ['milestone:M2'], { severity: 'critical' }),
      task('MS-2', ['milestone:M1'], { estimate: 1 }),
      task('MS-3', ['milestone:M1'], { estimate: 3 }),
      task('MS-4', ['milestone:M1'], { estimate: 2, severity: 'high' }),
      task('MS-5', ['milestone:M1'], { estimate: 2, severity: 'low' }),
      task('MS-6', ['milestone:M9']),
    ]
    const milestones = milestoneFile([
      { id: 'M2', rank: 2, seat: 'sample-seat' },
      { id: 'M1', rank: 1, seat: 'sample-seat' },
      { id: 'M9', rank: 0, seat: 'other-seat' },
    ])

    const { order } = planOrder(inputFor(tasks, { milestones }))

    expect(order.map(row => [row.id, row.tier, row.float])).toEqual([
      ['MS-3', 2, 0],
      ['MS-4', 2, 1],
      ['MS-5', 2, 1],
      ['MS-2', 2, 2],
      ['MS-1', 2, 0],
      ['MS-6', 3, undefined],
    ])
    expect(order[1]!.wsjf).toBeGreaterThan(order[2]!.wsjf!)
  })

  it('yields nothing from a milestone whose gate is open, and serves it once the gate closes', () => {
    const tasks = [task('GT-1', ['milestone:M3']), task('GT-2')]
    const raw = [
      { id: 'M2', rank: 1, seat: 'sample-seat' },
      { id: 'M3', rank: 2, seat: 'sample-seat', gated_by: 'M2' },
    ]

    const gated = planOrder(inputFor(tasks, { milestones: milestoneFile(raw) }))
    const open = planOrder(inputFor(tasks, { milestones: milestoneFile(raw, ['M2']) }))

    expect(ids(gated.order)).toEqual(['GT-2'])
    expect(gated.refused).toEqual({ 'gated:M3': 1 })
    expect(ids(open.order)).toEqual(['GT-1', 'GT-2'])
  })

  describe('CC-769: epics of an owned milestone', () => {
    const milestones = milestoneFile([{ id: 'M1', rank: 1, seat: 'sample-seat', epics: ['EP-1'] }])

    it('refuses an epic: entry at float 0 instead of putting it in tier 2', () => {
      const tasks = [task('EP-1', ['milestone:M1'], { estimate: 3 })]

      const planned = planOrder(inputFor(tasks, { milestones }))

      expect(criticalPath(parsePlanningTasks(tasks).tasks, 'M1').tasks[0]!.float).toBe(0)
      expect(planned.order).toEqual([])
      expect(planned.refused).toEqual({ 'epic:M1': 1 })
      expect(planned.epicsHeld).toEqual(['EP-1 epic:M1'])
    })

    it('refuses an estimate-13 task and keeps a 1-point slice of the same milestone in tier 2', () => {
      const tasks = [
        task('EP-2', ['milestone:M1'], { estimate: 13 }),
        task('EP-3', ['milestone:M1'], { estimate: 1 }),
      ]

      const planned = planOrder(inputFor(tasks, { milestones }))

      expect(planned.order.map(row => [row.id, row.tier])).toEqual([['EP-3', 2]])
      expect(planned.refused).toEqual({ 'epic-estimate:M1': 1 })
      expect(planned.epicsHeld).toEqual(['EP-2 epic-estimate:M1'])
    })

    it('leaves a big task outside an owned milestone in tier 3', () => {
      const { order, epicsHeld } = planOrder(inputFor([task('EP-4', [], { estimate: 13 })], { milestones }))

      expect(order.map(row => [row.id, row.tier])).toEqual([['EP-4', 3]])
      expect(epicsHeld).toEqual([])
    })
  })

  it('holds intangible tasks while anything else is ready, then dispatches them', () => {
    const intangible = task('IN-1', ['cos:intangible'], { severity: 'critical' })

    const held = planOrder(inputFor([intangible, task('IN-2')]))
    const alone = planOrder(inputFor([intangible, task('IN-3', ['dep:IN-4']), task('IN-4', ['dep:IN-3'])]))

    expect(ids(held.order)).toEqual(['IN-2'])
    expect(held.refused).toEqual({ 'intangible-held': 1 })
    expect(held.intangibleHeld).toEqual(['IN-1'])
    expect(alone.order.map(row => [row.id, row.tier])).toEqual([['IN-1', 4]])
  })

  it('stops at n across tiers', () => {
    const tasks = [task('NN-1', ['cos:expedite']), task('NN-2', ['cos:expedite']), task('NN-3')]

    expect(ids(planOrder(inputFor(tasks, { n: 2 })).order)).toEqual(['NN-1', 'NN-2'])
    expect(ids(planOrder(inputFor(tasks, { n: 3 })).order)).toEqual(['NN-1', 'NN-2', 'NN-3'])
  })
})

describe('planOrder readiness', () => {
  it('blocks a task with a dep: on an open task, and treats a dep: on a known closed task as closed', () => {
    const tasks = [task('DP-1'), task('DP-2', ['dep:DP-1']), task('DP-3', ['dep:DP-99'])]

    const { order, refused, tagErrors } = planOrder(inputFor(tasks, { knownIds: ['DP-99'] }))

    expect(ids(order).sort()).toEqual(['DP-1', 'DP-3'])
    expect(refused).toEqual({ 'dep-blocked': 1 })
    expect(tagErrors).toEqual([])
  })

  it('fails closed on a dep: naming no known task: refused as unknown-dep and listed in tagErrors', () => {
    const tasks = [task('UD-1'), task('UD-2', ['dep:UD-99']), task('UD-3', ['dep:UD-2'])]

    const { order, refused, tagErrors } = planOrder(inputFor(tasks, { knownIds: ['UD-50'] }))

    expect(ids(order)).toEqual(['UD-1'])
    expect(refused).toEqual({ 'unknown-dep': 1, 'dep-blocked': 1 })
    expect(tagErrors).toEqual([{ code: 'unknown-dep', task: 'UD-2', tag: 'dep:UD-99' }])
  })

  it('blocks a cycle and everything behind it, which criticalPath alone would schedule at float 0', () => {
    const tasks = [
      task('CY-1', ['milestone:M1', 'dep:CY-2']),
      task('CY-2', ['milestone:M1', 'dep:CY-1']),
      task('CY-3', ['milestone:M1', 'dep:CY-1']),
      task('CY-4', ['milestone:M1', 'dep:CY-3']),
      task('CY-5', ['milestone:M1', 'dep:CY-5']),
      task('CY-6', ['milestone:M1']),
    ]
    const milestones = milestoneFile([{ id: 'M1', rank: 1, seat: 'sample-seat' }])
    const paths = criticalPath(parsePlanningTasks(tasks).tasks, 'M1')

    const { order, refused } = planOrder(inputFor(tasks, { milestones }))

    expect(paths.tasks.find(t => t.id === 'CY-3')).toMatchObject({ earlyStart: 0, float: 0 })
    expect(ids(order)).toEqual(['CY-6'])
    expect(refused).toEqual({ 'cycle-blocked': 5 })
  })

  it('keeps an unestimated milestone task ready, with no WSJF', () => {
    const tasks = [task('UE-1', ['milestone:M1'], { estimate: null })]
    const milestones = milestoneFile([{ id: 'M1', rank: 1, seat: 'sample-seat' }])

    const { order } = planOrder(inputFor(tasks, { milestones }))

    expect(order.map(row => [row.id, row.tier, row.float, row.wsjf])).toEqual([['UE-1', 2, 0, undefined]])
  })

  it('computes WSJF as severity weight times one plus capped unblocks, over the estimate', () => {
    const tasks = [
      task('WS-1', [], { severity: 'critical', estimate: 4 }),
      ...['WS-2', 'WS-3', 'WS-4', 'WS-5'].map(id => task(id, [], { notes: 'Depends on WS-1.' })),
    ]

    const { order } = planOrder(inputFor(tasks))

    expect(order.find(row => row.id === 'WS-1')!.wsjf).toBe((1.0 * (1 + 3)) / 4)
  })
})
