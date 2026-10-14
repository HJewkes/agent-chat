import { describe, expect, it } from 'vitest'
import type { PoolGateInput } from '../agents/burndown/budget-gate.js'
import { dispatchStats, type DispatchStatsPorts } from '../agents/burndown/dispatch-stats.js'
import type { Task } from '../agents/burndown/eligibility.js'
import { EMPTY_LEDGER } from '../agents/burndown/ledger.js'
import type { ScoreRow, ScoringDefaults } from '../agents/burndown/score.js'
import type { SeatDispatch } from '../agents/burndown/seat-dispatch.js'
import { planSeat, type SeatBriefGate } from '../agents/burndown/seat-plan.js'
import { briefDepsOf, briefGateOf, type SeatPlanDeps } from '../agents/burndown/seat-tick.js'
import { TickConfigSchema } from '../agents/burndown/source.js'

/** CC-1106 slice d: the briefer floor and the dispatch-stats floor both read the config's `readyFloor`. */

const NOW = new Date('2026-10-14T12:00:00.000Z')
const REPO = '/tmp/repos/alpha-app'
const FRESH = 'brief:ready=2026-10-13'

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
  runStartAt: Date.parse('2026-10-14T08:00:00.000Z'),
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

const configWith = (readyFloor?: number) =>
  TickConfigSchema.parse({ maxAgents: 28, briefGate: { 'seat-a': 'on' }, readyFloor })

const gateFor = (readyFloor?: number): SeatBriefGate | undefined => {
  const deps = { brief: briefDepsOf(configWith(readyFloor)) } as SeatPlanDeps
  return briefGateOf(deps, 'seat-a').brief
}

const floorNotesAtDepth = (depth: number, brief: SeatBriefGate | undefined): string[] => {
  const ready = Array.from({ length: depth }, (_, i) => `R-${i + 1}`)
  const tasks = [task('A-1'), ...ready.map(id => task(id, [FRESH]))]
  const rows = [row('A-1', 99), ...ready.map(id => row(id, 5))]
  const planned = planSeat({
    seat: SEAT,
    rows,
    defaults: { initiative_decay: 0.5, share_caps: {} } as unknown as ScoringDefaults,
    tasks: new Map([['alpha', tasks]]),
    ledger: EMPTY_LEDGER,
    budget: POOL,
    brief,
    readPlan: () => ({ path: '/tmp/plan.md', text: undefined }),
  })
  return planned.notes.filter(n => n.includes('below floor'))
}

const statsPorts = (readyFloor?: number): DispatchStatsPorts => ({
  now: NOW,
  seats: () => ['seat-a'],
  tickRows: () => undefined,
  ledger: () => EMPTY_LEDGER,
  dispatchLog: () => undefined,
  journal: () => undefined,
  lastOkAt: () => undefined,
  maxAgents: () => 28,
  readyFloor: () => readyFloor,
  verdicts: () => [],
  gateRows: () => ({ rows: [], partial: false }),
})

describe('burndown readyFloor sets the briefer floor', () => {
  it('plans briefers at depth 39 under a configured floor of 40', () => {
    expect(floorNotesAtDepth(39, gateFor(40))).toEqual([expect.stringContaining('ready 39 below floor 40')])
  })

  it('plans no briefers at depth 40 under a configured floor of 40', () => {
    expect(floorNotesAtDepth(40, gateFor(40))).toEqual([])
  })

  it('keeps the floor at twice maxAgents when readyFloor is unset', () => {
    expect(gateFor()?.readyFloor).toBe(56)
  })
})

describe('burndown readyFloor sets the dispatch-stats floor', () => {
  it('reports the configured floor', () => {
    const [stats] = dispatchStats(statsPorts(40), 86_400_000)

    expect(stats?.readyFloor.floor).toBe(40)
  })

  it('reports twice maxAgents when readyFloor is unset', () => {
    const [stats] = dispatchStats(statsPorts(undefined), 86_400_000)

    expect(stats?.readyFloor.floor).toBe(56)
  })
})
