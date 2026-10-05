import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PoolGateInput } from '../agents/burndown/budget-gate.js'
import type { Task } from '../agents/burndown/eligibility.js'
import { EMPTY_LEDGER, type Ledger } from '../agents/burndown/ledger.js'
import { parseMilestoneFile } from '../agents/burndown/milestones.js'
import { mergeDefaults, parseCharter, parseSeat } from '../agents/burndown/policy.js'
import { scoreAll, type ScoredTask } from '../agents/burndown/score.js'
import { scoredPlan } from '../agents/burndown/score-render.js'
import { tasksFromList } from '../agents/burndown/score-source.js'
import type { SeatDispatch } from '../agents/burndown/seat-dispatch.js'
import { planSeat } from '../agents/burndown/seat-plan.js'
import { loadSeats, localDate, planSeats, type SeatTickDeps } from '../agents/burndown/seat-tick.js'
import { readInitiatives } from '../agents/burndown/source.js'

/** CC-768: the tick's seat plan is ordered by `planOrder`, as `burndown plan --scored` is. */

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'score-2026-09-29')
const AUTONOMY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'autonomy-2026-09-29')
const read = (file: string) => fs.readFileSync(path.join(FIXTURE, file), 'utf8')
const NOW = new Date(2026, 8, 29, 10)

interface Snapshot {
  today: string
  tasks: { id: string; slug: string }[]
}
const snapshot = JSON.parse(read('tasks.json')) as Snapshot
const WEIGHTS = (JSON.parse(read('expected-sample-seat.json')) as { initiatives: Record<string, number> })
  .initiatives

const charter = parseCharter(read('charter.md'))
const sample = parseSeat(read('seats/sample-seat.md'), 'sample-seat')
const defaults = mergeDefaults(charter, sample)
const exclusions = { tags: sample.excluded_tags, titlePatterns: sample.excluded_title_patterns }

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

const tagged = (extra: Record<string, string[]>): ScoredTask[] =>
  tasksFromList(snapshot).map(t => ({ ...t, tags: [...(t.tags ?? []), ...(extra[t.id] ?? [])] }))

const taskFile = (t: ScoredTask): Task => ({
  id: t.id,
  title: t.title,
  status: 'open',
  priority: t.priority,
  estimate: t.estimate ?? 0,
  doneWhen: t.done_when ?? '',
  tags: t.tags ?? [],
})

const milestoneFile = (ids: string[], extra = '') =>
  parseMilestoneFile(
    `week: 2026-W40\nappetite_days: 5\nmilestones:\n  - {id: M1, rank: 1, seat: sample-seat, epics: []}\n${extra}`,
    ids,
  ).file

function fixtureTick(
  tasks: ScoredTask[],
  milestones?: ReturnType<typeof milestoneFile>,
  today = snapshot.today,
) {
  const { rows } = scoreAll(tasks, WEIGHTS, defaults, exclusions, charter.hard_stops, today)
  const byInitiative = new Map<string, Task[]>()
  for (const t of tasks) byInitiative.set(t.slug, [...(byInitiative.get(t.slug) ?? []), taskFile(t)])
  const common = { seat: SEAT, rows, defaults, tasks: byInitiative, ledger: EMPTY_LEDGER, budget: POOL }
  const order = { tasks, today, ...(milestones && { milestones }) }
  return {
    ticked: planSeat({ ...common, order }),
    today: planSeat(common),
    scored: scoredPlan({
      tasks,
      weights: WEIGHTS,
      defaults,
      exclusions,
      hardStops: charter.hard_stops,
      today,
      top: rows.length,
      seat: SEAT.seat,
      ...(milestones && { milestones }),
    }),
  }
}

const withoutTier = (plan: ReturnType<typeof planSeat>) =>
  JSON.stringify(plan.dispatch.map(({ tier: _tier, ...rest }) => rest))

describe('planSeat ordered by planOrder', () => {
  const tags = {
    'AL-22': ['milestone:M1'],
    'BE-21': ['milestone:M1'],
    'GA-22': ['cos:expedite'],
    'AL-2': ['dep:AL-1'],
  }

  it("dispatches in the order of 'plan --scored' on the same inputs", () => {
    const ids = tasksFromList(snapshot).map(t => t.id)
    const { ticked, scored } = fixtureTick(tagged(tags), milestoneFile(ids))
    const refused = new Set(ticked.refusals.map(r => r.task))
    expect(ticked.dispatch.map(d => d.task)).toEqual(
      scored.order.map(r => r.id).filter(id => !refused.has(id)),
    )
    expect(ticked.dispatch.map(d => d.task).slice(0, 3)).toEqual(['GA-22', 'AL-22', 'BE-21'])
  })

  it('carries the planned tier on each dispatch', () => {
    const ids = tasksFromList(snapshot).map(t => t.id)
    const { ticked, scored } = fixtureTick(tagged(tags), milestoneFile(ids))
    const tierOf = new Map(scored.order.map(r => [r.id, r.tier]))
    expect(ticked.dispatch.slice(0, 3).map(d => d.tier)).toEqual([0, 2, 2])
    for (const d of ticked.dispatch) expect(d.tier).toBe(tierOf.get(d.task))
  })

  it('refuses a dep-blocked task with its reason instead of dropping it', () => {
    const { ticked } = fixtureTick(tagged(tags), milestoneFile([]))
    expect(ticked.refusals.filter(r => r.task === 'AL-2')).toEqual([
      expect.objectContaining({ kind: 'plan-blocked', reason: 'dep-blocked' }),
    ])
    expect(ticked.dispatch.map(d => d.task)).not.toContain('AL-2')
  })

  it('refuses a task of a gated milestone as gated:<id>', () => {
    const ids = tasksFromList(snapshot).map(t => t.id)
    const gated = milestoneFile(ids, '  - {id: M2, rank: 2, seat: sample-seat, epics: [], gated_by: M1}\n')
    const { ticked } = fixtureTick(tagged({ 'AL-22': ['milestone:M2'] }), gated)
    expect(ticked.refusals.filter(r => r.task === 'AL-22')).toEqual([
      expect.objectContaining({ kind: 'plan-blocked', reason: 'gated:M2' }),
    ])
  })

  it("keeps today's order with no milestone file and no planning tags", () => {
    const { ticked, today } = fixtureTick(tagged({}))
    expect(ticked.dispatch.length).toBeGreaterThan(5)
    expect(withoutTier(ticked)).toBe(withoutTier(today))
    expect(JSON.stringify(ticked.refusals)).toBe(JSON.stringify(today.refusals))
    expect(ticked.shareCapped).toEqual(today.shareCapped)
  })
})

describe('planSeats over the week milestone file', () => {
  let root: string
  const runStart = NOW.getTime() - 3_600_000
  const ledger: Ledger = {
    ...EMPTY_LEDGER,
    seats: {
      'seat-a': {
        samples: [
          { at: new Date(2026, 8, 29, 6).getTime(), sevenDay: 38 },
          { at: runStart, sevenDay: 39 },
        ],
      },
    },
  }
  const deps = (): SeatTickDeps => ({
    autonomyRoot: root,
    root,
    now: NOW,
    reading: () => ({ reading: { sevenDay: 40, fiveHour: 10, ageSeconds: 30 } }),
    recordedRunStart: () => runStart,
  })

  const addTask = (id: string, priority: number, tags: string[]) => {
    fs.mkdirSync(path.join(root, 'init-alpha', 'tasks'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'init-alpha', 'tasks', `${id}.yml`),
      `id: ${id}\ntitle: task ${id}\npriority: ${priority}\nseverity: high\nestimate: 2\n` +
        `done_when: The widget renders.\nstatus: open\ntags: [${tags.join(', ')}]\nnotes: ''\n` +
        'created: 2026-09-01\nupdated: 2026-09-20\ndone_at: null\n',
    )
  }

  const run = () => {
    const { loaded, skipped } = loadSeats(['seat-a'], ledger, deps())
    expect(skipped).toEqual([])
    return planSeats(loaded, { ledger, initiatives: readInitiatives(root) }, root)
  }

  const writeMilestones = (text: string) => {
    fs.mkdirSync(path.join(root, 'milestones'), { recursive: true })
    fs.writeFileSync(path.join(root, 'milestones', `${isoWeekOfNow()}.yml`), text)
  }
  const isoWeekOfNow = () => (localDate(NOW) === '2026-09-29' ? '2026-W40' : '')

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-seat-plan-order-'))
    fs.cpSync(AUTONOMY, root, { recursive: true })
    fs.mkdirSync(path.join(root, 'init-alpha'))
    fs.writeFileSync(path.join(root, 'init-alpha', 'brief.md'), '---\nstate: active\nrank: 1\n---\n')
    addTask('AA-1', 1, [])
    addTask('AA-2', 5, ['milestone:M1'])
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('puts the milestone task first when the file names the seat', () => {
    writeMilestones('week: 2026-W40\nappetite_days: 5\nmilestones:\n  - {id: M1, rank: 1, seat: seat-a}\n')
    expect(run().dispatch.map(d => [d.task, d.tier])).toEqual([
      ['AA-2', 2],
      ['AA-1', 3],
    ])
  })

  it('falls back to the tag-free order and reports a milestone file with errors', () => {
    writeMilestones(
      'week: 2026-W40\nappetite_days: 5\nmilestones:\n  - {id: M1, rank: 1, seat: seat-a, epics: [NOPE-1]}\n',
    )
    const plan = run()
    expect(plan.dispatch.map(d => d.task)).toEqual(['AA-1', 'AA-2'])
    expect(plan.refusals).toEqual([
      expect.objectContaining({ kind: 'plan-blocked', reason: expect.stringContaining('unknown-epic') }),
    ])
  })

  it('orders by the tags alone when there is no milestone file', () => {
    const plan = run()
    expect(plan.dispatch.map(d => d.task)).toEqual(['AA-1', 'AA-2'])
    expect(plan.refusals).toEqual([])
  })
})
