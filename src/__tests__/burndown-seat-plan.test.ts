import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { advance, claimKey } from '../agents/burndown/advance.js'
import type { PoolGateInput } from '../agents/burndown/budget-gate.js'
import type { Initiative, Task } from '../agents/burndown/eligibility.js'
import { EMPTY_LEDGER, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import type { Capacity, Dispatch } from '../agents/burndown/plan.js'
import { checkSeatPrefixes, loadPolicy, type SeatPolicy } from '../agents/burndown/policy.js'
import type { ScoreRow, ScoringDefaults } from '../agents/burndown/score.js'
import type { SeatDispatch } from '../agents/burndown/seat-dispatch.js'
import { planSeat, priorPicksOf, type SeatPlanInputs } from '../agents/burndown/seat-plan.js'
import { backlogIds, seatScopeOf } from '../agents/burndown/seat-scope.js'
import { activeTreeOf } from '../agents/burndown/seat-tick.js'
import type { Step } from '../agents/burndown/execute.js'
import { stepsForDispatch, type StepContext } from '../agents/burndown/steps.js'
import type { AgentIdentity, AgentLifecycle } from '../protocol.js'

/** CC-247: prior picks, the pure seat planner, and the seat identity seams from the #196 review. */

const NOW = new Date('2026-09-29T12:00:00.000Z')
const RUN_START = Date.parse('2026-09-29T08:00:00.000Z')
const REPO = '/tmp/repos/alpha-app'

const SEAT: SeatDispatch = {
  seat: 'seat-a',
  prefix: 'sa',
  pool: { name: 'pool-x', human_uses: false, reserve_seven_day: 20, ceiling_five_hour: 80 },
  configDir: '/tmp/pool-x',
  repos: { alpha: [REPO, '/tmp/repos/alpha-docs'], beta: ['/tmp/repos/beta'] },
  caps: { implementers: 2, reviewers: 1, planners: 1 },
  worktrees: { perRepoPerSeat: 3, capName: 'worktrees_per_repo_per_seat', leftFreePerRepo: 2 },
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

function inputs(rows: ScoreRow[], tasks: Task[], patch: Partial<SeatPlanInputs> = {}): SeatPlanInputs {
  const byInitiative = new Map<string, Task[]>()
  for (const r of rows) {
    const t = tasks.find(x => x.id === r.id)
    if (t !== undefined) byInitiative.set(r.initiative, [...(byInitiative.get(r.initiative) ?? []), t])
  }
  return {
    seat: SEAT,
    rows,
    defaults: DEFAULTS,
    tasks: byInitiative,
    ledger: EMPTY_LEDGER,
    budget: openPool(),
    ...patch,
  }
}

const one = (
  id: string,
  t: Partial<Task> = {},
  r: Partial<ScoreRow> = {},
  patch: Partial<SeatPlanInputs> = {},
) => planSeat(inputs([row(id, 50, r)], [task(id, t)], patch))

const refusalOf = (plan: ReturnType<typeof planSeat>) => plan.refusals.map(x => [x.task, x.kind])

describe('planSeat dispatch', () => {
  it('dispatches in scored order with the seat, prefix and pool config dir', () => {
    const plan = planSeat(inputs([row('A-1', 40), row('A-2', 60)], [task('A-1'), task('A-2')]))

    expect(plan.dispatch).toEqual([
      expect.objectContaining({
        task: 'A-2',
        agentName: 'sa-a-2',
        worktree: `${REPO}/.worktrees/sa-a-2`,
        seat: 'seat-a',
        namePrefix: 'sa',
        configDir: '/tmp/pool-x',
        account: 'pool-x',
        profile: 'bd-implementer',
      }),
      expect.objectContaining({ task: 'A-1', agentName: 'sa-a-1' }),
    ])
    expect(plan.refusals).toEqual([])
  })

  it('routes a planner into the checkout with no worktree', () => {
    const plan = one('A-1', { estimate: 5 }, { route: 'planner' })

    expect(plan.dispatch).toEqual([
      expect.objectContaining({ profile: 'bd-planner', cwd: REPO, agentName: 'sa-a-1' }),
    ])
    expect(plan.dispatch[0]?.worktree).toBeUndefined()
  })

  it('picks the repo a repo: tag names', () => {
    const plan = one('A-1', { tags: ['repo:alpha-docs'] })

    expect(plan.dispatch[0]?.repo).toBe('/tmp/repos/alpha-docs')
  })

  it('decays an initiative by the claims the seat dispatched this run', () => {
    const rows = [row('A-1', 60), row('B-1', 40, { initiative: 'beta' })]
    const ledger: Ledger = {
      ...EMPTY_LEDGER,
      claims: [claim('A-0', { phase: 'done' }), claim('A-9', { phase: 'done' })],
    }

    const plan = planSeat(inputs(rows, [task('A-1'), task('B-1')], { ledger }))

    expect(plan.priorPicks).toEqual({ alpha: 2 })
    expect(plan.dispatch.map(d => d.task)).toEqual(['B-1', 'A-1'])
  })
})

describe('priorPicksOf', () => {
  it("counts only the seat's whole-task claims spawned since run start", () => {
    const ledger: Ledger = {
      ...EMPTY_LEDGER,
      claims: [
        claim('A-1'),
        claim('A-2', { slice: 'a' }),
        claim('A-3', { seat: 'seat-b' }),
        claim('A-4', { spawnedAt: '2026-09-29T07:00:00.000Z' }),
        claim('B-1', { initiative: 'beta', phase: 'done' }),
      ],
    }

    expect(priorPicksOf(ledger, 'seat-a', RUN_START)).toEqual({ alpha: 1, beta: 1 })
  })
})

describe('planSeat refusals', () => {
  it('refuses a task the ledger already holds as ineligible', () => {
    const ledger: Ledger = { ...EMPTY_LEDGER, claims: [claim('A-1', { seat: 'seat-b' })] }

    expect(refusalOf(one('A-1', {}, {}, { ledger }))).toEqual([['A-1', 'claimed']])
  })

  it('refuses a scored row with no task file as ineligible', () => {
    expect(refusalOf(planSeat(inputs([row('A-1', 50)], [])))).toEqual([['A-1', 'not-open']])
  })

  it('refuses a task with no estimate as untriaged', () => {
    const { estimate: _estimate, ...unestimated } = task('A-1')

    expect(refusalOf(planSeat(inputs([row('A-1', 50)], [unestimated])))).toEqual([['A-1', 'untriaged']])
  })

  it('refuses a triage route as untriaged', () => {
    expect(refusalOf(one('A-1', {}, { route: 'triage' }))).toEqual([['A-1', 'untriaged']])
  })

  it('refuses a done_when that stops short', () => {
    const plan = one('A-1', {}, { stopShort: ['deploy'] })

    expect(plan.refusals).toEqual([
      expect.objectContaining({ kind: 'stop-short', reason: expect.stringContaining('deploy') }),
    ])
  })

  it('refuses an initiative the seat lists no repo for', () => {
    const plan = one('G-1', {}, { initiative: 'gamma' })

    expect(plan.refusals).toEqual([
      expect.objectContaining({ kind: 'no-repo', reason: 'seat seat-a lists no repo for gamma' }),
    ])
  })

  it('refuses a collision from the injected check, given the chosen repo', () => {
    const seen: string[] = []
    const collision = (repo: string) => {
      seen.push(repo)
      return { kind: 'open-pr' as const, reason: 'PR #7 names A-1' }
    }

    const plan = one('A-1', {}, {}, { collision })

    expect(refusalOf(plan)).toEqual([['A-1', 'open-pr']])
    expect(seen).toEqual([REPO])
  })

  it('hands the check every repo in the seat so a landing in any of them refuses', () => {
    const listed: (readonly string[] | undefined)[] = []
    const collision = (_repo: string, _work: unknown, landedRepos?: readonly string[]) => {
      listed.push(landedRepos)
      return undefined
    }

    one('A-1', {}, {}, { collision })

    expect(listed.find(repos => repos !== undefined)).toEqual([
      REPO,
      '/tmp/repos/alpha-docs',
      '/tmp/repos/beta',
    ])
  })

  it('refuses an orphan found under the seat-prefixed agent name', () => {
    const names: string[] = []
    const orphan = (_repo: string, name: string) => {
      names.push(name)
      return 'branch agent-chat/sa-a-1 exists'
    }

    expect(refusalOf(one('A-1', {}, {}, { orphan }))).toEqual([['A-1', 'orphan']])
    expect(names).toEqual(['sa-a-1'])
  })

  it('refuses at the role cap, counting held claims by phase and nextPhase', () => {
    const ledger: Ledger = {
      ...EMPTY_LEDGER,
      claims: [claim('A-8'), claim('A-9', { phase: 'spawning', nextPhase: 'implementing' })],
    }

    const plan = planSeat(
      inputs(
        [row('A-1', 50), row('A-2', 40, { route: 'planner' })],
        [task('A-1'), task('A-2', { estimate: 5 })],
        {
          ledger,
        },
      ),
    )

    expect(refusalOf(plan)).toEqual([['A-1', 'role-cap']])
    expect(plan.dispatch.map(d => d.task)).toEqual(['A-2'])
  })

  it("does not count another seat's claims or a reviewing claim toward implementers", () => {
    const ledger: Ledger = {
      ...EMPTY_LEDGER,
      claims: [claim('A-8', { seat: 'seat-b' }), claim('A-9', { phase: 'reviewing' })],
    }

    expect(one('A-1', {}, {}, { ledger }).dispatch).toHaveLength(1)
  })

  it('stops at the role cap within one plan', () => {
    const rows = [row('A-1', 50), row('A-2', 40), row('A-3', 30)]

    const plan = planSeat(inputs(rows, [task('A-1'), task('A-2'), task('A-3')]))

    expect(plan.dispatch.map(d => d.task)).toEqual(['A-1', 'A-2'])
    expect(refusalOf(plan)).toEqual([['A-3', 'role-cap']])
  })

  it("refuses at the seat's worktrees_per_repo_per_seat", () => {
    const worktree = (n: string) => ({ worktree: `${REPO}/.worktrees/sa-a-${n}`, phase: 'parked' as const })
    const ledger: Ledger = {
      ...EMPTY_LEDGER,
      claims: [claim('A-7', worktree('7')), claim('A-8', worktree('8')), claim('A-9', worktree('9'))],
    }

    const plan = one('A-1', {}, {}, { ledger })

    expect(plan.refusals).toEqual([
      expect.objectContaining({
        kind: 'worktrees',
        reason: expect.stringContaining('worktrees_per_repo_per_seat is 3'),
      }),
    ])
  })

  it('adds worktrees_left_free_per_repo to the broker-wide reserve', () => {
    const capacity: Capacity = {
      agents: 5,
      agentsReason: 'free',
      worktrees: () => ({ total: 5, ours: 0, totalCeiling: 7, oursCeiling: 5 }),
    }

    const plan = one('A-1', {}, {}, { capacity })

    expect(plan.refusals).toEqual([
      expect.objectContaining({ kind: 'worktrees', reason: expect.stringContaining('the tick stops at 5') }),
    ])
  })

  it('refuses on broker slots from the capacity', () => {
    const capacity: Capacity = {
      agents: 0,
      agentsReason: '3 of maxAgents 3',
      worktrees: () => ({ total: 0, ours: 0, totalCeiling: 10, oursCeiling: 5 }),
    }

    expect(refusalOf(one('A-1', {}, {}, { capacity }))).toEqual([['A-1', 'slots']])
  })

  it('refuses with budget and the BUDGET-PAUSE reason when the pool gate is closed', () => {
    const budget = { ...openPool(), reading: undefined }

    const plan = one('A-1', {}, {}, { budget })

    expect(plan.refusals).toEqual([
      expect.objectContaining({
        kind: 'budget',
        reason: expect.stringMatching(/^BUDGET-PAUSE pool pool-x: /),
      }),
    ])
  })

  it('dispatches only sonnet profiles when the pool is sonnet only', () => {
    const budget = openPool({ sevenDay: 75, fiveHour: 10, ageSeconds: 30 })
    const rows = [row('A-1', 50), row('A-2', 40, { route: 'implementer-lite' })]

    const plan = planSeat(inputs(rows, [task('A-1'), task('A-2', { estimate: 1 })], { budget }))

    expect(plan.dispatch.map(d => [d.task, d.profile])).toEqual([['A-2', 'bd-implementer-lite']])
    expect(plan.refusals).toEqual([
      expect.objectContaining({
        task: 'A-1',
        kind: 'budget',
        reason: expect.stringContaining('sonnet only'),
      }),
    ])
  })
})

describe('planSeat active worktrees (CC-279)', () => {
  const capped: SeatDispatch = {
    ...SEAT,
    worktrees: { perRepoPerSeat: 2, capName: 'concurrency.implementers', leftFreePerRepo: 2 },
  }
  const tree = (n: string) => `${REPO}/.worktrees/sa-a-${n}`
  const held = (n: string, phase: Claim['phase']): Claim =>
    claim(`A-${n}`, { phase, worktree: tree(n), agentName: `sa-a-${n}` })
  const agent = (name: string, state: AgentLifecycle, cwd = '/tmp/elsewhere'): AgentIdentity =>
    ({ name, state, cwd, spawnedAt: 1 }) as AgentIdentity
  const plan = (claims: Claim[], agents: AgentIdentity[]) =>
    one(
      'A-1',
      {},
      {},
      {
        seat: capped,
        ledger: { ...EMPTY_LEDGER, claims },
        activeTree: activeTreeOf({ agents }),
      },
    )

  it('dispatches when the seat has more branches than implementers but the extra trees are parked', () => {
    const claims = [held('7', 'awaiting-merge'), held('8', 'awaiting-merge'), held('9', 'parked')]
    const agents = [agent('sa-a-7', 'exited'), agent('sa-a-8', 'retired'), agent('sa-a-9', 'live')]

    const result = plan(claims, agents)

    expect(result.dispatch.map(d => d.task)).toEqual(['A-1'])
  })

  it('refuses when the active trees reach the implementers cap', () => {
    const claims = [held('7', 'parked'), held('8', 'parked'), held('9', 'awaiting-merge')]
    const agents = [agent('sa-a-7', 'live'), agent('sa-a-8', 'live'), agent('sa-a-9', 'exited')]

    const result = plan(claims, agents)

    expect(result.refusals).toEqual([
      expect.objectContaining({
        kind: 'worktrees',
        reason: expect.stringContaining(
          'holds 2 active worktrees under /tmp/repos/alpha-app/.worktrees; concurrency.implementers is 2',
        ),
      }),
    ])
  })

  it("counts a spawning claim with no roster row and a spawning agent's tree as active", () => {
    const claims = [held('7', 'spawning'), held('8', 'parked')]

    const result = plan(claims, [agent('sa-a-8', 'spawning')])

    expect(refusalOf(result)).toEqual([['A-1', 'worktrees']])
  })

  it('counts a tree a live agent of another name stands in', () => {
    const claims = [held('7', 'parked'), held('8', 'parked')]
    const agents = [
      agent('sa-a-7', 'live'),
      agent('sa-a-8', 'exited'),
      agent('other', 'live', `${tree('8')}/src`),
    ]

    const result = plan(claims, agents)

    expect(refusalOf(result)).toEqual([['A-1', 'worktrees']])
  })
})

describe('planSeat follow-ups from the #199 review', () => {
  it('counts prior picks only inside the 12-hour run, however early runStartAt is', () => {
    const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()
    const ledger: Ledger = {
      ...EMPTY_LEDGER,
      claims: [
        claim('A-0', { phase: 'done', spawnedAt: hoursAgo(13) }),
        claim('A-9', { spawnedAt: hoursAgo(2) }),
      ],
    }
    const budget = { ...openPool(), runStartAt: NOW.getTime() - 20 * 3_600_000 }

    expect(one('A-1', {}, {}, { ledger, budget }).priorPicks).toEqual({ alpha: 1 })
  })

  it('applies share caps over all rows, so a longer scope loosens them', () => {
    const defaults = { ...DEFAULTS, share_caps: { nit: 0.2 } } as ScoringDefaults
    const nits = (n: number) => Array.from({ length: n }, (_, i) => row(`A-${i}`, 50 - i, { kind: 'nit' }))
    const plan = (n: number) =>
      planSeat(
        inputs(
          nits(n),
          nits(n).map(r => task(r.id)),
          { defaults },
        ),
      )

    expect(plan(5).shareCapped).toEqual({ 'share-cap:nit': 4 })
    expect(plan(5).dispatch.map(d => d.task)).toEqual(['A-0'])
    expect(plan(10).shareCapped).toEqual({ 'share-cap:nit': 8 })
    expect(plan(10).dispatch.map(d => d.task)).toEqual(['A-0', 'A-1'])
  })

  it("refuses a reserved tag and a missing grant through taskRefusal, and passes the seat's grants on", () => {
    const merge = { doneWhen: 'The PR is merged once green.' }

    expect(refusalOf(one('A-1', { tags: ['human-only'] }))).toEqual([['A-1', 'reserved-tag']])
    expect(refusalOf(one('A-1', merge))).toEqual([['A-1', 'needs-grant']])
    const granted = { ...SEAT, grants: ['merge-on-green-approve'] }
    expect(one('A-1', merge, {}, { seat: granted }).dispatch).toEqual([
      expect.objectContaining({ task: 'A-1', grants: ['merge-on-green-approve'] }),
    ])
  })

  it("dispatches the seat's ready slices before scored work, with the slice's owned paths", () => {
    const slice = (taskId: string, patch: Partial<Claim> = {}): Claim =>
      claim(taskId, { phase: 'queued', slice: 'b', owns: ['src/x.ts'], ...patch })
    const ledger: Ledger = {
      ...EMPTY_LEDGER,
      claims: [slice('A-1'), slice('A-2', { seat: 'seat-b' }), slice('A-3', { dependsOn: ['a'] })],
    }
    const owned: string[][] = []
    const collision = (_repo: string, work: { owns: string[] }) => (owned.push(work.owns), undefined)

    const plan = planSeat(inputs([row('A-5', 50)], [task('A-1'), task('A-5')], { ledger, collision }))

    expect(plan.dispatch.map(d => [d.task, d.slice, d.agentName, d.worktree])).toEqual([
      ['A-1', 'b', 'sa-a-1-b', `${REPO}/.worktrees/sa-a-1-b`],
      ['A-5', undefined, 'sa-a-5', `${REPO}/.worktrees/sa-a-5`],
    ])
    expect(owned[0]).toEqual(['src/x.ts'])
  })

  it('refuses with trust when the pool config dir has not trusted the spawn cwd', () => {
    const seen: string[][] = []
    const trust = (repo: string, cwd: string, configDir: string) => (
      seen.push([repo, cwd, configDir]),
      'no trust entry'
    )

    expect(refusalOf(one('A-1', {}, {}, { trust }))).toEqual([['A-1', 'trust']])
    expect(seen).toEqual([[REPO, `${REPO}/.worktrees/sa-a-1`, '/tmp/pool-x']])
  })
})

describe('planSeat pool charges and same-tick claims (CC-275)', () => {
  const queued = (taskId: string, patch: Partial<Claim> = {}): Claim =>
    claim(taskId, { phase: 'queued', slice: 'b', owns: ['src/x.ts'], ...patch })

  it('refuses a ready slice with budget when the pool gate is closed', () => {
    const ledger: Ledger = { ...EMPTY_LEDGER, claims: [queued('A-1')] }
    const budget = { ...openPool(), reading: undefined }

    const plan = planSeat(inputs([], [task('A-1')], { ledger, budget }))

    expect(plan.dispatch).toEqual([])
    expect(plan.refusals).toEqual([
      expect.objectContaining({
        task: 'A-1',
        kind: 'budget',
        reason: expect.stringMatching(/^BUDGET-PAUSE /),
      }),
    ])
  })

  it('charges each dispatch against the pool before gating the next', () => {
    const seat = { ...SEAT, pool: { ...SEAT.pool, dispatch_seven_day_points: 40 } }
    const budget = { ...openPool(), pool: seat.pool }

    const plan = planSeat(
      inputs([row('A-1', 60), row('A-2', 50)], [task('A-1'), task('A-2')], { seat, budget }),
    )

    expect(plan.dispatch.map(d => d.task)).toEqual(['A-1'])
    expect(plan.refusals).toEqual([
      expect.objectContaining({
        task: 'A-2',
        kind: 'budget',
        reason: expect.stringContaining('seven_day 80% at or above line 80%'),
      }),
    ])
  })

  it('keeps charging from the earlier seats count after its own dispatch', () => {
    const seat = { ...SEAT, pool: { ...SEAT.pool, dispatch_seven_day_points: 20 } }
    const budget = { ...openPool(), pool: seat.pool, dispatched: 1 }

    const plan = planSeat(
      inputs([row('A-1', 60), row('A-2', 50)], [task('A-1'), task('A-2')], { seat, budget }),
    )

    expect(plan.dispatch.map(d => d.task)).toEqual(['A-1'])
    expect(refusalOf(plan)).toEqual([['A-2', 'budget']])
  })

  it('starts from the dispatches earlier seats charged to the pool', () => {
    const budget = { ...openPool(), dispatched: 20 }

    expect(refusalOf(one('A-1', {}, {}, { budget }))).toEqual([['A-1', 'budget']])
  })

  it('returns each dispatch with the slice, tags and owns its collision check saw', () => {
    const ledger: Ledger = { ...EMPTY_LEDGER, claims: [queued('A-1')] }
    const tasks = [task('A-1', { tags: ['ui'] }), task('A-5', { tags: ['api'] })]
    const seen: unknown[] = []
    const collision = (_repo: string, work: unknown) => (seen.push(work), undefined)

    const plan = planSeat(
      inputs([row('A-5', 50)], tasks, { ledger, collision, tasks: new Map([['alpha', tasks]]) }),
    )

    expect(plan.claims).toEqual([
      {
        seat: 'seat-a',
        repo: REPO,
        agentName: 'sa-a-1-b',
        work: { taskId: 'A-1', slice: 'b', tags: ['ui'], owns: ['src/x.ts'], contracts: [] },
      },
      { seat: 'seat-a', repo: REPO, agentName: 'sa-a-5', work: { taskId: 'A-5', tags: ['api'], owns: [] } },
    ])
    expect(seen).toEqual(plan.claims.map(c => c.work))
  })

  it('dispatches one of two ready sibling slices that clash on a scope and refuses the other (CC-710)', () => {
    const scope = 'api:/v1/report'
    const ledger: Ledger = {
      ...EMPTY_LEDGER,
      claims: [
        queued('A-1', { slice: 'b', contracts: [{ scope, op: 'remove' }] }),
        queued('A-1', { slice: 'c', contracts: [{ scope, op: 'extend' }] }),
      ],
    }

    const plan = planSeat(inputs([], [task('A-1')], { ledger }))

    expect(plan.dispatch.map(d => d.slice)).toEqual(['b'])
    expect(plan.refusals).toEqual([expect.objectContaining({ task: 'A-1', kind: 'contract-overlap' })])
  })

  it('dispatches two ready sibling slices whose contracts are both additive', () => {
    const scope = 'api:/v1/report'
    const ledger: Ledger = {
      ...EMPTY_LEDGER,
      claims: [
        queued('A-1', { slice: 'b', contracts: [{ scope, op: 'add' }] }),
        queued('A-1', { slice: 'c', contracts: [{ scope, op: 'extend' }] }),
      ],
    }

    const plan = planSeat(inputs([], [task('A-1')], { ledger }))

    expect(plan.dispatch.map(d => d.slice)).toEqual(['b', 'c'])
  })

  it("passes a ready slice's contracts to the collision check (CC-710)", () => {
    const contracts = [{ scope: 'api:/v1/report', op: 'remove' as const }]
    const ledger: Ledger = { ...EMPTY_LEDGER, claims: [queued('A-1', { contracts })] }
    const seen: { contracts?: unknown }[] = []
    const collision = (_repo: string, work: { contracts?: unknown }) => (seen.push(work), undefined)

    planSeat(inputs([row('A-5', 50)], [task('A-1'), task('A-5')], { ledger, collision }))

    expect(seen[0]?.contracts).toEqual(contracts)
  })
})

describe('seat seams from the CC-246 review', () => {
  it("(a) gives a seat planner's slices the planner's seat and prefix", () => {
    const planner = claim('X-1', { phase: 'planning', agentName: 'sa-x-1' })
    const slices = [{ n: 'a', title: 'first', dependsOn: [], owns: [] }]
    const observed = new Map([[claimKey(planner), { agent: { id: 'p', state: 'exited' as const }, slices }]])

    const added = advance([planner], observed, NOW).find(a => a.kind === 'add')

    expect(added).toEqual({
      kind: 'add',
      claims: [expect.objectContaining({ slice: 'a', seat: 'seat-a', namePrefix: 'sa' })],
    })
  })

  it('(c) writes the dispatch seat and prefix onto the claim and spawns on the pool config dir', () => {
    const d: Dispatch = {
      initiative: 'alpha',
      task: 'A-1',
      profile: 'bd-implementer',
      account: 'pool-x',
      cwd: `${REPO}/.worktrees/sa-a-1`,
      repo: REPO,
      agentName: 'sa-a-1',
      worktree: `${REPO}/.worktrees/sa-a-1`,
      reason: 'test',
      seat: 'seat-a',
      namePrefix: 'sa',
      configDir: '/tmp/pool-x',
    }

    const steps = stepsForDispatch(d, stepContext())

    expect(steps).toEqual([
      {
        kind: 'ledger',
        actions: [
          {
            kind: 'add',
            claims: [expect.objectContaining({ taskId: 'A-1', seat: 'seat-a', namePrefix: 'sa' })],
          },
        ],
      },
      expect.objectContaining({
        frame: expect.objectContaining({ name: 'sa-a-1', configDir: '/tmp/pool-x' }),
      }),
    ])
  })

  it('(c) carries the planned tier on the spawn frame, and leaves it off when the plan placed none', () => {
    const d: Dispatch = {
      initiative: 'alpha',
      task: 'A-1',
      profile: 'bd-implementer',
      account: 'pool-x',
      cwd: `${REPO}/.worktrees/sa-a-1`,
      repo: REPO,
      agentName: 'sa-a-1',
      worktree: `${REPO}/.worktrees/sa-a-1`,
      reason: 'test',
      seat: 'seat-a',
      namePrefix: 'sa',
      configDir: '/tmp/pool-x',
    }
    const frameOf = (dispatch: Dispatch): Record<string, unknown> => {
      const steps = stepsForDispatch(dispatch, stepContext())
      const spawn = (steps as Step[]).find(s => s.kind === 'spawn')
      return (spawn as Extract<Step, { kind: 'spawn' }>).frame as unknown as Record<string, unknown>
    }

    expect(frameOf({ ...d, tier: 2 })).toMatchObject({ tier: 2 })
    expect(frameOf(d)).not.toHaveProperty('tier')
  })
})

describe('(e) checkSeatPrefixes', () => {
  const seats = (...prefixes: (string | undefined)[]): Record<string, SeatPolicy> =>
    Object.fromEntries(prefixes.map((prefix, i) => [`seat-${i}`, { prefix } as SeatPolicy]))

  it('accepts distinct lowercase prefixes and a seat with none', () => {
    expect(() => checkSeatPrefixes(seats('sa', 'sb2', undefined))).not.toThrow()
  })

  it.each([
    ['a duplicate', ['sa', 'sa'], 'seats seat-0 and seat-1 share prefix sa'],
    ["the tick's bd", ['bd'], "prefix bd is the tick's own"],
    ["another prefix plus '-'", ['sa', 'sa-x'], 'prefix sa-x is not [a-z0-9]+'],
    ['an uppercase letter', ['Sa'], 'prefix Sa is not [a-z0-9]+'],
    ['an underscore', ['s_a'], 'prefix s_a is not [a-z0-9]+'],
  ])('rejects %s', (_case, prefixes, message) => {
    expect(() => checkSeatPrefixes(seats(...prefixes))).toThrow(message)
  })

  it('runs inside loadPolicy over every seat, not just the one asked for', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-seat-prefix-'))
    fs.cpSync(FIXTURE, root, { recursive: true })
    const seatC = path.join(root, 'seats', 'seat-c.md')
    fs.writeFileSync(seatC, fs.readFileSync(seatC, 'utf8').replace('prefix: sc', 'prefix: sb'))

    expect(() => loadPolicy(root, 'seat-a')).toThrow('seats seat-b and seat-c share prefix sb')
    fs.rmSync(root, { recursive: true, force: true })
  })
})

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'autonomy-2026-09-29')

function stepContext(): StepContext {
  const initiative: Initiative = {
    slug: 'alpha',
    state: 'focused',
    autonomy: { mode: 'burndown', lanes: 1, accounts: [], grants: [], repo: REPO },
  }
  return {
    now: NOW,
    root: '/tmp/aw',
    initiatives: new Map([['alpha', initiative]]),
    tasks: new Map([['alpha', [task('A-1')]]]),
    reportTo: 'coord',
    repoFacts: () => ({ defaultBranch: 'main' }),
    account: () => ({ account: 'pool-x' }),
    configDir: account => `/tmp/accounts/${account}`,
    trust: () => undefined,
    taskText: () => 'id: A-1',
    readFile: () => undefined,
    running: () => false,
  }
}

describe('planSeat stop the line (CC-629)', () => {
  const stop = { previous: 'not loaded', current: 'not loaded', message: 'serve is not loaded' }
  const expedite = { tags: ['cos:expedite'] }

  it('refuses every implementer row but cos:expedite on a stopped line, before collision', () => {
    const collision = () => ({ kind: 'file-overlap' as const, reason: 'overlaps' })
    const rows = [row('A-1', 60), row('A-2', 50, { route: 'implementer-lite' }), row('A-3', 40)]
    const tasks = [task('A-1'), task('A-2'), task('A-3', expedite)]

    const plan = planSeat(inputs(rows, tasks, { lineStop: stop }))
    const withCollision = planSeat(inputs(rows, tasks, { lineStop: stop, collision }))

    expect(plan.dispatch.map(d => d.task)).toEqual(['A-3'])
    expect(refusalOf(plan)).toEqual([
      ['A-1', 'stop-line'],
      ['A-2', 'stop-line'],
    ])
    expect(plan.refusals[0]?.reason).toBe(
      'service check failed twice (not loaded, then not loaded): serve is not loaded; only cos:expedite dispatches',
    )
    expect(refusalOf(withCollision).slice(0, 2)).toEqual([
      ['A-1', 'stop-line'],
      ['A-2', 'stop-line'],
    ])
  })

  it("dispatches a ready slice of an expedite task on a stopped line, and refuses another's", () => {
    const queued = (taskId: string) => claim(taskId, { phase: 'queued', slice: 'b', owns: [] })
    const ledger: Ledger = { ...EMPTY_LEDGER, claims: [queued('A-1'), queued('A-2')] }
    const tasks = [task('A-1', expedite), task('A-2')]

    const plan = planSeat(inputs([], tasks, { ledger, lineStop: stop, tasks: new Map([['alpha', tasks]]) }))

    expect(plan.dispatch.map(d => [d.task, d.slice])).toEqual([['A-1', 'b']])
    expect(refusalOf(plan)).toEqual([['A-2', 'stop-line']])
  })
})

describe('planSeat seat scope (CC-779)', () => {
  const policy = (patch: Record<string, unknown>) =>
    ({ initiatives: {}, scope_tags: [], ...patch }) as unknown as SeatPolicy
  const SEATS = {
    'seat-a': policy({ initiatives: { alpha: 1, beta: 1 }, scope_tags: ['lane:a'], backlog: 'backlog.md' }),
    'seat-b': policy({ initiatives: { alpha: 1 } }),
  }
  const scoped = (backlog: string[] = []) => seatScopeOf(SEATS, 'seat-a', new Set(backlog))

  it('refuses a task in a shared initiative that carries none of the scope tags, with the reason', () => {
    const plan = one('A-1', { tags: ['lane:b'] }, {}, { scope: scoped() })

    expect(plan.dispatch).toEqual([])
    expect(plan.refusals).toEqual([
      expect.objectContaining({
        task: 'A-1',
        kind: 'out-of-scope',
        reason: expect.stringMatching(/scope_tags \[lane:a\] and backlog\.md does not name it/),
      }),
    ])
  })

  it('keeps a task the backlog names, whatever its tags', () => {
    const plan = one('A-1', { tags: ['lane:b'] }, {}, { scope: scoped(['A-1']) })

    expect(plan.dispatch.map(d => d.task)).toEqual(['A-1'])
  })

  it('keeps a task carrying a scope tag, and every task of an initiative no other seat lists', () => {
    const rows = [row('A-1', 50), row('B-1', 40, { initiative: 'beta' })]
    const plan = planSeat(inputs(rows, [task('A-1', { tags: ['lane:a'] }), task('B-1')], { scope: scoped() }))

    expect(plan.dispatch.map(d => d.task)).toEqual(['A-1', 'B-1'])
  })

  it('reads the task IDs a backlog file names', () => {
    expect([...backlogIds('1. Take CC-12 first, then AB-3; not cc-4 or X-y.')]).toEqual(['CC-12', 'AB-3'])
  })
})

describe('planSeat hand spawns against the caps (CC-779)', () => {
  const agent = (name: string, profile: string, state: AgentLifecycle = 'live'): AgentIdentity =>
    ({ name, profile, state, cwd: '/tmp/elsewhere', spawnedAt: 1 }) as AgentIdentity
  const seat = { ...SEAT, caps: { ...SEAT.caps, implementers: 3 } }

  it('fills a cap of three with two live hand spawns and one claim', () => {
    const ledger: Ledger = { ...EMPTY_LEDGER, claims: [claim('A-9', { agentName: 'sa-a-9' })] }
    const agents = [agent('sa-cc-1-fix', 'implementer'), agent('sa-hand-2', 'opus-implementer')]

    const plan = one('A-1', {}, {}, { seat, ledger, agents })

    expect(refusalOf(plan)).toEqual([['A-1', 'role-cap']])
    expect(plan.refusals[0]?.reason).toMatch(/holds 3 of 3 implementers/)
  })

  it('does not count again an agent a claim holds, nor exited, other-prefix or roleless agents', () => {
    const ledger: Ledger = {
      ...EMPTY_LEDGER,
      claims: [claim('A-9', { agentName: 'sa-a-9', spawned: ['sa-a-9'] })],
    }
    const agents = [
      agent('sa-a-9', 'implementer'),
      agent('sa-a-9-s1', 'implementer'),
      agent('sa-done', 'implementer', 'exited'),
      agent('sb-other', 'implementer'),
      agent('sa-architect', 'fable-architect'),
    ]

    const plan = one('A-1', {}, {}, { seat, ledger, agents })

    expect(plan.dispatch.map(d => d.task)).toEqual(['A-1'])
  })
})
