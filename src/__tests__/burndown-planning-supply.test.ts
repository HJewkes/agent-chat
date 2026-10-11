import { describe, expect, it } from 'vitest'
import type { PoolGateInput } from '../agents/burndown/budget-gate.js'
import type { Task } from '../agents/burndown/eligibility.js'
import { EMPTY_LEDGER } from '../agents/burndown/ledger.js'
import { planningCandidates, readyDepth } from '../agents/burndown/planning-supply.js'
import type { ScoreRow, ScoringDefaults } from '../agents/burndown/score.js'
import type { SeatDispatch } from '../agents/burndown/seat-dispatch.js'
import { planSeat, type SeatBriefGate } from '../agents/burndown/seat-plan.js'

/** CC-986 slice b: below the ready floor, briefers take the top no-brief rows up to the planner cap. */

const NOW = new Date('2026-09-29T12:00:00.000Z')
const REPO = '/tmp/repos/alpha-app'
const FRESH = 'brief:ready=2026-09-28'

const SEAT: SeatDispatch = {
  seat: 'seat-a',
  prefix: 'sa',
  pool: { name: 'pool-x', human_uses: false, reserve_seven_day: 20, ceiling_five_hour: 80 },
  configDir: '/tmp/pool-x',
  repos: { alpha: [REPO] },
  caps: { implementers: 4, reviewers: 1, planners: 2 },
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

const row = (id: string, score: number): ScoreRow =>
  ({
    id,
    initiative: 'alpha',
    score,
    effective: score,
    kind: 'platform',
    blocked: [],
    stopShort: [],
    route: 'implementer',
    components: { W: 1 },
  }) as unknown as ScoreRow

const task = (id: string, tags: string[] = []): Task => ({
  id,
  title: `task ${id}`,
  status: 'open',
  priority: 1,
  estimate: 2,
  doneWhen: 'The widget renders.',
  tags,
})

const IDS = ['A-1', 'A-2', 'A-3', 'A-4', 'A-5']
const ROWS = IDS.map((id, i) => row(id, 90 - i * 10))
const GATE: SeatBriefGate = { gate: 'on', maxAgeDays: 14, readyFloor: 4 }

const plan = (tasks: Task[], brief: SeatBriefGate = GATE, rows: ScoreRow[] = ROWS, seat = SEAT) =>
  planSeat({
    seat,
    rows,
    defaults: { initiative_decay: 0.5, share_caps: {} } as unknown as ScoringDefaults,
    tasks: new Map([['alpha', tasks]]),
    ledger: EMPTY_LEDGER,
    budget: POOL,
    brief,
    readPlan: () => ({ path: '/tmp/plan.md', text: undefined }),
  })

const briefers = (planned: ReturnType<typeof plan>) =>
  planned.dispatch.filter(d => d.briefer === true).map(d => d.task)

describe('planSeat below the ready floor (CC-986)', () => {
  it('dispatches briefers on the two highest no-brief rows when the planner cap is 2', () => {
    const planned = plan(IDS.map(id => task(id)))

    expect(briefers(planned)).toEqual(['A-1', 'A-2'])
    expect(planned.dispatch.every(d => d.profile === 'bd-planner')).toBe(true)
    expect(planned.refusals.map(r => [r.task, r.kind])).toEqual([
      ['A-3', 'no-brief'],
      ['A-4', 'no-brief'],
      ['A-5', 'no-brief'],
    ])
    expect(planned.notes).toContain('seat seat-a ready 0 below floor 4: planning 2 no-brief tasks')
  })

  it('dispatches no briefer when the ready depth is at the floor', () => {
    const ready = ['R-1', 'R-2', 'R-3', 'R-4']
    const tasks = [...IDS.map(id => task(id)), ...ready.map(id => task(id, [FRESH]))]
    const rows = [...ROWS, ...ready.map(id => row(id, 5))]
    const roomy = { ...SEAT, caps: { ...SEAT.caps, planners: 20 } }

    const planned = plan(tasks, { ...GATE, readyFloor: 4 }, rows, roomy)

    expect(briefers(planned)).toEqual([])
    expect(planned.notes.some(n => n.includes('below floor'))).toBe(false)
    expect(planned.refusals.filter(r => r.kind === 'no-brief')).toHaveLength(5)
  })

  it('skips person steps, umbrellas and tasks whose brief awaits approval', () => {
    const tasks = [
      task('A-1', ['kind:owner']),
      task('A-2', ['kind:operator']),
      task('A-3', ['kind:epic']),
      task('A-4', ['brief:proposed=2026-09-28']),
      task('A-5'),
      task('A-6', ['epic:A-5']),
      task('A-7', ['needs-decision']),
      task('A-8'),
    ]
    const rows = tasks.map((t, i) => row(t.id, 90 - i * 5))

    const planned = plan(tasks, GATE, rows)

    expect(briefers(planned)).toEqual(['A-6', 'A-8'])
    expect(planned.refusals.find(r => r.task === 'A-7')?.kind).toBe('reserved-tag')
  })

  it.each(['shadow', 'off'] as const)('runs no pass under a %s gate', gate => {
    const planned = plan(
      IDS.map(id => task(id)),
      { ...GATE, gate },
    )

    expect(briefers(planned)).toEqual([])
    expect(planned.notes.some(n => n.includes('below floor'))).toBe(false)
  })

  it('runs no pass when the gate carries no floor', () => {
    const planned = plan(
      IDS.map(id => task(id)),
      { gate: 'on', maxAgeDays: 14 },
    )

    expect(briefers(planned)).toEqual([])
  })
})

describe('readyDepth and planningCandidates', () => {
  const check = { maxAgeDays: 14, now: NOW }
  const tasks = [task('A-1', [FRESH]), task('A-2', [FRESH]), task('A-3')]
  const taskOf = (r: { id: string }) => tasks.find(t => t.id === r.id)

  it('counts unclaimed fresh brief:ready rows plus ready slices', () => {
    const order = tasks.map(t => ({ initiative: 'alpha', id: t.id }))

    expect(readyDepth(order, taskOf, check, new Set(['A-2']), 3)).toBe(4)
  })

  it('keeps only no-brief refusals, in order', () => {
    const refusals = [
      { initiative: 'alpha', task: 'A-3', kind: 'no-brief' as const, reason: 'x' },
      { initiative: 'alpha', task: 'A-1', kind: 'claimed' as const, reason: 'x' },
      { initiative: 'alpha', task: 'A-2', kind: 'no-brief' as const, reason: 'x' },
    ]

    const kept = planningCandidates(refusals, new Map([['alpha', tasks]]))

    expect(kept.map(r => r.task)).toEqual(['A-3', 'A-2'])
  })
})
