import { describe, expect, it } from 'vitest'
import type { PoolGateInput } from '../agents/burndown/budget-gate.js'
import type { Task } from '../agents/burndown/eligibility.js'
import type { ReviewBackpressure } from '../agents/burndown/flow-gate.js'
import { EMPTY_LEDGER, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { stopOf } from '../agents/burndown/no-dispatch.js'
import type { ReviewBacklog } from '../agents/burndown/review-backlog.js'
import type { ScoreRow, ScoringDefaults } from '../agents/burndown/score.js'
import type { SeatDispatch } from '../agents/burndown/seat-dispatch.js'
import { planSeat, type SeatPlanInputs } from '../agents/burndown/seat-plan.js'

/** CC-1106 slice b: planSeat holds new implementers while reviews queue past k x Shepherd's review cap. */

const NOW = new Date('2026-10-14T12:00:00.000Z')
const REPO = '/tmp/repos/alpha-app'

const SEAT: SeatDispatch = {
  seat: 'seat-a',
  prefix: 'sa',
  pool: { name: 'pool-x', human_uses: false, reserve_seven_day: 20, ceiling_five_hour: 80 },
  configDir: '/tmp/pool-x',
  repos: { alpha: [REPO] },
  caps: { implementers: 4, reviewers: 1, planners: 2 },
  worktrees: { perRepoPerSeat: 4, capName: 'worktrees_per_repo_per_seat', leftFreePerRepo: 0 },
  excludedTags: [],
  grants: [],
}

const POOL: PoolGateInput = {
  pool: SEAT.pool,
  spend: {},
  reading: { sevenDay: 40, fiveHour: 10, ageSeconds: 30 },
  history: [],
  runStartAt: Date.parse('2026-10-14T08:00:00.000Z'),
  ctx: { now: NOW },
}

const row = (id: string, route = 'implementer'): ScoreRow =>
  ({
    id,
    initiative: 'alpha',
    score: 50,
    kind: 'platform',
    blocked: [],
    stopShort: [],
    route,
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

const queuedSlice = (taskId: string): Claim => ({
  taskId,
  initiative: 'alpha',
  seat: 'seat-a',
  namePrefix: 'sa',
  spawnedAt: '2026-10-14T09:00:00.000Z',
  phase: 'queued',
  phaseAt: '2026-10-14T09:00:00.000Z',
  slice: 'b',
  owns: [],
})

const ON: ReviewBackpressure = { mode: 'on', k: 2 }
const backlog = (queued: number): ReviewBacklog => ({ queued, waiting: queued, running: 0, cap: 16 })

function plan(rows: ScoreRow[], tasks: Task[], patch: Partial<SeatPlanInputs> = {}) {
  return planSeat({
    seat: SEAT,
    rows,
    defaults: { initiative_decay: 0.5, share_caps: {} } as unknown as ScoringDefaults,
    tasks: new Map([['alpha', tasks]]),
    ledger: EMPTY_LEDGER,
    budget: POOL,
    ...patch,
  })
}

const MIXED = {
  rows: [row('A-1'), row('A-2', 'planner'), row('A-3')],
  tasks: [task('A-1'), task('A-2'), task('A-3', ['cos:expedite']), task('A-4')],
  ledger: { ...EMPTY_LEDGER, claims: [queuedSlice('A-4')] } as Ledger,
}

const mixed = (patch: Partial<SeatPlanInputs>) =>
  plan(MIXED.rows, MIXED.tasks, { ledger: MIXED.ledger, ...patch })
const dispatched = (p: ReturnType<typeof plan>) => p.dispatch.map(d => d.slice ?? d.task).sort()
const refused = (p: ReturnType<typeof plan>) => p.refusals.map(r => [r.task, r.slice, r.kind])

describe('planSeat review backpressure (CC-1106)', () => {
  it('refuses an implementer task and a ready slice at 33 queued, k 2, cap 16, but sends the planner and expedite', () => {
    const p = mixed({ reviewBacklog: backlog(33), reviewBackpressure: ON })

    expect(dispatched(p)).toEqual(['A-2', 'A-3'])
    expect(refused(p)).toEqual(
      expect.arrayContaining([
        ['A-4', 'b', 'review-backpressure'],
        ['A-1', undefined, 'review-backpressure'],
      ]),
    )
    expect(p.refusals.find(r => r.task === 'A-1')?.gate?.lever).toBe('burndown.reviewBackpressure.k')
    expect(stopOf(p.refusals)?.name).toBe('review backpressure')
  })

  it('dispatches every implementer at 32 queued', () => {
    const p = mixed({ reviewBacklog: backlog(32), reviewBackpressure: ON })

    expect(dispatched(p)).toEqual(['A-1', 'A-2', 'A-3', 'b'])
  })

  it('dispatches in shadow with one would-refuse note for the seat, and silently when off', () => {
    const shadow = mixed({ reviewBacklog: backlog(33), reviewBackpressure: { mode: 'shadow', k: 2 } })
    const off = mixed({ reviewBacklog: backlog(33), reviewBackpressure: { mode: 'off', k: 2 } })

    expect(dispatched(shadow)).toEqual(['A-1', 'A-2', 'A-3', 'b'])
    expect(shadow.notes.filter(n => n.includes('review-backpressure'))).toEqual([
      'seat seat-a would-refuse review-backpressure: 33 reviews queued (33 waiting, 0 running) above 2 x cap 16',
    ])
    expect(dispatched(off)).toEqual(['A-1', 'A-2', 'A-3', 'b'])
    expect(off.notes.filter(n => n.includes('review'))).toEqual([])
  })

  it('dispatches on an unread backlog with one note for the seat', () => {
    const p = mixed({
      reviewBacklog: { unknown: 'shepherd status carried no reviewSlots' },
      reviewBackpressure: ON,
    })

    expect(dispatched(p)).toEqual(['A-1', 'A-2', 'A-3', 'b'])
    expect(p.notes.filter(n => n.includes('review backpressure'))).toEqual([
      'seat seat-a review backpressure unread, implementers dispatch: shepherd status carried no reviewSlots',
    ])
  })

  it('still sends a briefer below the ready floor while implementers are held', () => {
    const brief = { gate: 'on' as const, maxAgeDays: 14, readyFloor: 2 }

    const p = plan([row('A-1')], [task('A-1')], { brief, reviewBacklog: backlog(40), reviewBackpressure: ON })

    expect(p.dispatch.map(d => [d.task, d.briefer])).toEqual([['A-1', true]])
  })
})
