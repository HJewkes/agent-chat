import { describe, expect, it } from 'vitest'
import type { PoolGateInput } from '../agents/burndown/budget-gate.js'
import type { Task } from '../agents/burndown/eligibility.js'
import { CAP_KINDS } from '../agents/burndown/gate-reading.js'
import { EMPTY_LEDGER, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { capacityRefusal, type Capacity } from '../agents/burndown/plan.js'
import { agentCapacity } from '../agents/burndown/run-tick.js'
import type { ScoreRow, ScoringDefaults } from '../agents/burndown/score.js'
import type { SeatDispatch } from '../agents/burndown/seat-dispatch.js'
import { planSeat, type SeatPlanInputs } from '../agents/burndown/seat-plan.js'
import { TickConfigSchema } from '../agents/burndown/source.js'

/** CC-1097 b: every refusal `blocker()` makes names the lever behind it, with figures for a capacity cap. */

const NOW = new Date('2026-09-29T12:00:00.000Z')
const REPO = '/tmp/repos/alpha-app'

const SEAT: SeatDispatch = {
  seat: 'seat-a',
  prefix: 'sa',
  pool: { name: 'pool-x', human_uses: false, reserve_seven_day: 20, ceiling_five_hour: 80 },
  configDir: '/tmp/pool-x',
  repos: { alpha: [REPO] },
  caps: { implementers: 2, reviewers: 1, planners: 1 },
  worktrees: { perRepoPerSeat: 3, capName: 'concurrency.implementers', leftFreePerRepo: 2 },
  excludedTags: [],
  grants: [],
}

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

const pool = (reading?: PoolGateInput['reading']): PoolGateInput => ({
  pool: SEAT.pool,
  spend: {},
  reading,
  history: [],
  runStartAt: Date.parse('2026-09-29T08:00:00.000Z'),
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

const held = (n: number, patch: Partial<Claim> = {}): Ledger => ({
  ...EMPTY_LEDGER,
  claims: Array.from({ length: n }, (_, i) => claim(`H-${i}`, { agentName: `sa-h-${i}`, ...patch })),
})

function planOne(patch: Partial<SeatPlanInputs> = {}, rows = [row('A-1', 50)], tasks = [task('A-1')]) {
  return planSeat({
    seat: SEAT,
    rows,
    defaults: { initiative_decay: 0.5, share_caps: {} } as unknown as ScoringDefaults,
    tasks: new Map([['alpha', tasks]]),
    ledger: EMPTY_LEDGER,
    budget: pool({ sevenDay: 40, fiveHour: 10, ageSeconds: 30 }),
    ...patch,
  })
}

const gateOf = (plan: ReturnType<typeof planSeat>) => plan.refusals[0]?.gate

describe('role-cap gates', () => {
  it('names concurrency.implementers with the held count against the cap', () => {
    const plan = planOne({ ledger: held(2) })

    expect(plan.refusals[0]?.reason).toBe('seat seat-a holds 2 of 2 implementers')
    expect(gateOf(plan)).toEqual({
      lever: 'concurrency.implementers',
      value: 2,
      reading: 2,
      headroom: 0,
      source: 'seats/<seat>.md',
    })
  })

  it('names burndown.handReserve with the tick share as its value', () => {
    const seat = { ...SEAT, caps: { ...SEAT.caps, implementers: 4 } }

    const plan = planOne({ seat, ledger: held(2), handReserve: 2 })

    expect(gateOf(plan)).toMatchObject({ lever: 'burndown.handReserve', value: 2, reading: 2, headroom: 0 })
  })
})

describe('worktree gates', () => {
  it("names the seat ceiling by the seat's own capName", () => {
    const capName = 'charter.defaults.worktrees_per_repo_per_seat'
    const seat = { ...SEAT, worktrees: { ...SEAT.worktrees, perRepoPerSeat: 1, capName } }
    const ledger = held(1, { phase: 'parked', worktree: `${REPO}/.worktrees/sa-h-0` })

    const plan = planOne({ seat, ledger })

    expect(plan.refusals[0]?.kind).toBe('worktrees')
    expect(gateOf(plan)).toMatchObject({ lever: capName, value: 1, reading: 1, headroom: 0 })
  })

  it('names worktreeBudget and maxWorktreesPerRepo for the tick ceilings', () => {
    const tally = { agents: 0, worktrees: new Map([[REPO, 1]]) }
    const capacity = (use: ReturnType<Capacity['worktrees']>): Capacity => ({
      agents: 5,
      agentsReason: 'free',
      agentsGate: () => ({ lever: 'unused', value: null, reading: null, headroom: null, source: '' }),
      worktrees: () => use,
    })
    const d = { repo: REPO, worktree: `${REPO}/.worktrees/sa-a-1` }

    const total = capacityRefusal(d, capacity({ total: 6, ours: 0, totalCeiling: 7, oursCeiling: 5 }), tally)
    const ours = capacityRefusal(d, capacity({ total: 0, ours: 4, totalCeiling: 9, oursCeiling: 5 }), tally)

    expect(total?.gate).toMatchObject({ lever: 'worktreeBudget', value: 7, reading: 7, headroom: 0 })
    expect(ours?.gate).toMatchObject({
      lever: 'burndown.maxWorktreesPerRepo',
      value: 5,
      reading: 5,
      source: 'burndown.config.json',
    })
  })
})

describe('agent slot gates (agentCapacity)', () => {
  const spawning = (n: number): Claim[] =>
    Array.from({ length: n }, (_, i) => claim(`S-${i}`, { phase: 'spawning', agentName: `bd-s-${i}` }))
  const config = TickConfigSchema.parse({ maxAgents: 3, reserveSlots: 2 })

  it('names burndown.maxAgents when the live count fills it', () => {
    const capacity = agentCapacity(config, spawning(3), { agents: [], slots: { held: 4, cap: 36 } })

    expect(capacity.agents).toBe(0)
    expect(capacity.agentsGate(0)).toMatchObject({ lever: 'burndown.maxAgents', value: 3, reading: 3 })
  })

  it('names agentSlots when the broker is fuller than maxAgents allows', () => {
    const capacity = agentCapacity(config, [], { agents: [], slots: { held: 34, cap: 36 } })

    expect(capacity.agentsGate(capacity.agents)).toMatchObject({
      lever: 'agentSlots',
      value: 36,
      reading: 36,
      headroom: 0,
    })
  })

  it('counts agents the tick started before the refusal into the reading', () => {
    const capacity = agentCapacity(config, spawning(1), { agents: [], slots: { held: 4, cap: 36 } })

    expect(capacity.agentsGate(-1)).toMatchObject({ lever: 'burndown.maxAgents', reading: 4, headroom: -1 })
  })

  it('reaches a slots refusal through capacityRefusal with the tally taken off the room', () => {
    const agents = agentCapacity(config, [], { agents: [], slots: { held: 4, cap: 36 } })
    const capacity: Capacity = {
      ...agents,
      worktrees: () => ({ total: 0, ours: 0, totalCeiling: 9, oursCeiling: 9 }),
    }

    const refused = capacityRefusal({ repo: REPO }, capacity, { agents: 3, worktrees: new Map() })

    expect(refused).toMatchObject({
      kind: 'slots',
      gate: { lever: 'burndown.maxAgents', value: 3, reading: 3 },
    })
  })

  it('reads an unread broker as a binary agentSlots gate', () => {
    const capacity = agentCapacity(config, [], { agents: [] })

    expect(capacity.agentsGate(0)).toMatchObject({ lever: 'agentSlots', value: null, reading: null })
  })
})

describe('budget gates', () => {
  it("passes the pool gate's own reading through", () => {
    const plan = planOne({ budget: pool(undefined) })

    expect(plan.refusals[0]?.kind).toBe('budget')
    expect(gateOf(plan)).toMatchObject({ lever: 'pools.pool-x.reading', value: null })
  })

  it('names the sonnet band as a binary gate when the task needs a larger model', () => {
    const plan = planOne({ budget: pool({ sevenDay: 75, fiveHour: 10, ageSeconds: 30 }) })

    expect(gateOf(plan)).toMatchObject({ lever: 'pools.pool-x.sonnet_band_points', value: null })
  })
})

describe('binary gates', () => {
  it('gives every refusal blocker() makes a gate, numeric only for the capacity kinds', () => {
    const rows = ['A-1', 'A-2', 'A-3', 'A-4', 'A-5'].map((id, i) => row(id, 90 - i))
    const tasks = rows.map(r => task(r.id))
    const collision = (_repo: string, work: { taskId: string }) =>
      work.taskId === 'A-1' ? { kind: 'file-overlap' as const, reason: 'overlaps' } : undefined
    const trust = (_repo: string, cwd: string) => (cwd.endsWith('sa-a-2') ? 'untrusted' : undefined)
    const orphan = (_repo: string, name: string) => (name === 'sa-a-3' ? 'branch exists' : undefined)

    const plan = planOne({ ledger: held(1), collision, trust, orphan }, rows, tasks)

    expect(plan.refusals.map(r => [r.task, r.kind, r.gate?.lever])).toEqual([
      ['A-1', 'file-overlap', 'gate.file-overlap'],
      ['A-2', 'trust', 'gate.trust'],
      ['A-3', 'orphan', 'gate.orphan'],
      ['A-5', 'role-cap', 'concurrency.implementers'],
    ])
    for (const r of plan.refusals) {
      expect(r.gate?.value === null).toBe(!CAP_KINDS.has(r.kind))
    }
  })

  it('names a stopped line as gate.stop-line', () => {
    const lineStop = { previous: 'loaded', current: 'not loaded', message: 'serve is not loaded' }

    expect(gateOf(planOne({ lineStop }))).toEqual({
      lever: 'gate.stop-line',
      value: null,
      reading: null,
      headroom: null,
      source: 'service line stop',
    })
  })
})
