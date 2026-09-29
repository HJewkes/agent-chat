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
import { tickPrefixes, type SeatDispatch } from '../agents/burndown/seat-dispatch.js'
import { planSeat, priorPicksOf, type SeatPlanInputs } from '../agents/burndown/seat-plan.js'
import { stepsForDispatch, type StepContext } from '../agents/burndown/steps.js'

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
  worktrees: { perRepoPerSeat: 3, leftFreePerRepo: 2 },
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

  it('(d) lists bd and every configured seat prefix for the tick', () => {
    const policy = loadPolicy(FIXTURE, 'seat-a')

    expect(tickPrefixes([], () => policy)).toEqual(['bd'])
    expect(tickPrefixes(['seat-a', 'seat-b'], () => policy)).toEqual(['bd', 'sa', 'sb'])
  })

  it('(d) refuses a configured seat that cannot dispatch', () => {
    const policy = loadPolicy(FIXTURE, 'seat-a')

    expect(() => tickPrefixes(['seat-hub'], () => policy)).toThrow('seat-hub is the hub seat')
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
  }
}
