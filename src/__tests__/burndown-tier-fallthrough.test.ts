import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { PoolGateInput } from '../agents/burndown/budget-gate.js'
import type { Task } from '../agents/burndown/eligibility.js'
import { EMPTY_LEDGER, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { parseMilestoneFile } from '../agents/burndown/milestones.js'
import { mergeDefaults, parseCharter, parseSeat } from '../agents/burndown/policy.js'
import { dispatchOrder, scoreAll, type ScoredTask } from '../agents/burndown/score.js'
import type { SeatDispatch } from '../agents/burndown/seat-dispatch.js'
import { planSeat, type SeatBriefGate } from '../agents/burndown/seat-plan.js'

/**
 * CC-988 b: when every tier-2 (milestone) row is refused, the tick falls through to tier 3 even where
 * initiative decay has taken every tier-3 row's effective score to 0.0.
 */

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'score-2026-09-29')
const read = (file: string) => fs.readFileSync(path.join(FIXTURE, file), 'utf8')
const TODAY = '2026-09-29'
const SPAWNED_AT = '2026-09-29T09:00:00.000Z'

const charter = parseCharter(read('charter.md'))
const sample = parseSeat(read('seats/sample-seat.md'), 'sample-seat')
const defaults = mergeDefaults(charter, sample)
const WEIGHTS = { alpha: 1.0, beta: 0.8, gamma: 0.8 }

const SEAT: SeatDispatch = {
  seat: 'sample-seat',
  prefix: 'ss',
  pool: { name: 'pool-x', human_uses: false, reserve_seven_day: 20, ceiling_five_hour: 80 },
  configDir: '/tmp/pool-x',
  repos: Object.fromEntries(Object.keys(WEIGHTS).map(slug => [slug, [`/tmp/repos/${slug}`]])),
  caps: { implementers: 100, reviewers: 100, planners: 100 },
  worktrees: { perRepoPerSeat: 100, capName: 'worktrees_per_repo_per_seat', leftFreePerRepo: 0 },
  excludedTags: [],
  grants: ['merge-on-green-approve'],
}

const POOL: PoolGateInput = {
  pool: SEAT.pool,
  spend: {},
  reading: { sevenDay: 40, fiveHour: 10, ageSeconds: 30 },
  history: [],
  runStartAt: Date.parse('2026-09-29T08:00:00.000Z'),
  ctx: { now: new Date('2026-09-29T12:00:00.000Z') },
}

const ON: SeatBriefGate = { gate: 'on', maxAgeDays: 14 }

const task = (id: string, slug: string, severity: string, tags: string[] = []): ScoredTask => ({
  id,
  title: `task ${id}`,
  priority: 3,
  severity,
  estimate: 2,
  done_when: 'The widget renders.',
  tags: [...tags, `brief:ready=${TODAY}`],
  created: '2026-09-01',
  updated: '2026-09-20',
  slug,
})

const MILESTONE = parseMilestoneFile(
  'week: 2026-W40\nappetite_days: 5\nmilestones:\n  - {id: M1, rank: 1, seat: sample-seat, epics: []}\n',
  [],
).file!

const TIER_3 = [
  task('AL-1', 'alpha', 'high'),
  task('AL-2', 'alpha', 'critical'),
  task('BE-1', 'beta', 'critical'),
  task('BE-2', 'beta', 'low'),
]

const claim = (taskId: string, initiative: string, seat: string, phase: Claim['phase']): Claim => ({
  taskId,
  initiative,
  seat,
  namePrefix: seat === SEAT.seat ? SEAT.prefix : 'ot',
  spawnedAt: SPAWNED_AT,
  phase,
  phaseAt: SPAWNED_AT,
})

/** Done claims of this run: each decays its initiative's tier-3 rows by `initiative_decay` without holding a task. */
const priorPicks = (initiative: string, n: number): Claim[] =>
  Array.from({ length: n }, (_, i) => claim(`${initiative}-done-${i}`, initiative, SEAT.seat, 'done'))

const taskFile = (t: ScoredTask): Task => ({
  id: t.id,
  title: t.title,
  status: 'open',
  priority: t.priority,
  estimate: t.estimate ?? 0,
  doneWhen: t.done_when ?? '',
  tags: t.tags ?? [],
})

function tick(tasks: ScoredTask[], claims: Claim[], brief?: SeatBriefGate) {
  const { rows } = scoreAll(tasks, WEIGHTS, defaults, { tags: [] }, charter.hard_stops, TODAY)
  const byInitiative = new Map<string, Task[]>()
  for (const t of tasks) byInitiative.set(t.slug, [...(byInitiative.get(t.slug) ?? []), taskFile(t)])
  const plan = planSeat({
    seat: SEAT,
    rows,
    defaults,
    order: { tasks, today: TODAY, milestones: MILESTONE },
    tasks: byInitiative,
    ledger: { ...EMPTY_LEDGER, claims },
    budget: POOL,
    ...(brief !== undefined && { brief }),
  })
  return { plan, rows }
}

const highestRaw = (rows: ReturnType<typeof tick>['rows'], ids: readonly string[]) =>
  rows.filter(r => ids.includes(r.id)).reduce((a, b) => (b.score > a.score ? b : a)).id

describe('planSeat falls through refused tier 2 to tier 3', () => {
  const tier2 = [
    task('GA-1', 'gamma', 'critical', ['milestone:M1']),
    task('GA-2', 'gamma', 'high', ['milestone:M1']),
  ]
  const tier3Ids = TIER_3.map(t => t.id)
  const held = [
    claim('GA-1', 'gamma', 'other', 'implementing'),
    claim('GA-2', 'gamma', 'other', 'implementing'),
    ...priorPicks('alpha', 60),
    ...priorPicks('beta', 60),
  ]

  it('dispatches the highest-raw tier-3 row at decayed effective 0.0 when every tier-2 row is claimed', () => {
    const { plan, rows } = tick([...tier2, ...TIER_3], held)

    expect(plan.refusals.filter(r => r.task?.startsWith('GA-')).map(r => [r.task, r.kind])).toEqual([
      ['GA-1', 'claimed'],
      ['GA-2', 'claimed'],
    ])
    expect(plan.dispatch.map(d => d.tier)).toEqual(tier3Ids.map(() => 3))
    expect(plan.dispatch.map(d => d.reason)).toEqual(
      tier3Ids.map(() => expect.stringContaining('effective 0;')),
    )
    expect(plan.dispatch[0]?.task).toBe(highestRaw(rows, tier3Ids))
    expect(plan.dispatch.map(d => d.task).sort()).toEqual([...tier3Ids].sort())
  })

  it('dispatches the highest-raw tier-3 row under an on brief gate when every tier-2 row is claimed', () => {
    const { plan, rows } = tick([...tier2, ...TIER_3], held, ON)

    expect(plan.refusals.filter(r => r.task?.startsWith('GA-')).map(r => [r.task, r.kind])).toEqual([
      ['GA-1', 'claimed'],
      ['GA-2', 'claimed'],
    ])
    expect(plan.dispatch[0]?.task).toBe(highestRaw(rows, tier3Ids))
    expect(plan.dispatch.map(d => d.task).sort()).toEqual([...tier3Ids].sort())
  })
})

describe('planSeat with a dispatchable tier-2 row', () => {
  const free = task('AL-9', 'alpha', 'low', ['milestone:M1'])

  it('dispatches the tier-2 row first under an off gate, ahead of higher-scored tier-3 rows', () => {
    const { plan, rows } = tick([free, ...TIER_3], [])

    const score = (id: string) => rows.find(r => r.id === id)!.score
    expect(
      score(
        highestRaw(
          rows,
          TIER_3.map(t => t.id),
        ),
      ),
    ).toBeGreaterThan(score('AL-9'))
    expect(plan.dispatch[0]).toEqual(expect.objectContaining({ task: 'AL-9', tier: 2 }))
  })

  it("keeps tier 3 in dispatchOrder's decay order with the tier-2 pick counted against its initiative", () => {
    const { plan, rows } = tick([free, ...TIER_3], [])

    const tier3Rows = rows.filter(r => r.id !== 'AL-9')
    const expected = dispatchOrder(tier3Rows, defaults, tier3Rows.length, { alpha: 1 }).order
    expect(plan.dispatch.slice(1).map(d => d.task)).toEqual(expected.map(r => r.id))
    expect(plan.dispatch.slice(1).map(d => d.reason)).toEqual(
      expected.map(r => expect.stringContaining(`effective ${r.effective};`)),
    )
    expect(plan.placement?.picks.map(p => p.id)).toEqual(['AL-9', ...expected.map(r => r.id)])
  })
})
