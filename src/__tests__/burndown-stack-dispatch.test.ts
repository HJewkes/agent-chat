import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Initiative, Task } from '../agents/burndown/eligibility.js'
import type { Runner } from '../agents/burndown/exec.js'
import { execute, type ExecuteDeps, type SpawnFrame, type Step } from '../agents/burndown/execute.js'
import type { Claim, Ledger, StackedOn } from '../agents/burndown/ledger.js'
import { stackInputs, type Dispatch } from '../agents/burndown/plan.js'
import type { SeatDispatch } from '../agents/burndown/seat-dispatch.js'
import { planSeat } from '../agents/burndown/seat-plan.js'
import { registerWithShepherd, type ShepherdRow } from '../agents/burndown/shepherd.js'
import { stepsForDispatch, type StepContext } from '../agents/burndown/steps.js'
import type { IsolationContext } from '../agents/isolation/index.js'
import { createWorktreeStrategy } from '../agents/isolation/worktree.js'
import { PortSpawnFrame } from '../cli/verbs/port-agent.js'
import type { SetupRunner } from '../agents/isolation/worktree-setup.js'

/** CC-1158 slice b: a stacked slice is cut from, opens its PR on, and registers after its parent's branch. */

const NOW = new Date('2026-10-01T12:00:00.000Z')
const AT = NOW.toISOString()
const REPO_SLUG = 'example-org/example-repo'
const CHECKOUT = '/tmp/example-checkout'
const PARENT_BRANCH = 'agent-chat/bd-t-1-a'
const PARENT_PR = `https://github.com/${REPO_SLUG}/pull/10`
const STACKED: StackedOn = { taskId: 'T-1', slice: 'a', pr: PARENT_PR, branch: PARENT_BRANCH }

const tmpdirs: string[] = []
afterEach(() => {
  while (tmpdirs.length > 0) fs.rmSync(tmpdirs.pop() ?? '', { recursive: true, force: true })
})

const tmpdir = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpdirs.push(dir)
  return dir
}

const claim = (over: Partial<Claim> = {}): Claim => ({
  taskId: 'T-1',
  initiative: 'demo',
  spawnedAt: AT,
  phaseAt: AT,
  phase: 'queued',
  slice: 'b',
  dependsOn: ['a'],
  ...over,
})

const dispatch = (over: Partial<Dispatch> = {}): Dispatch => ({
  initiative: 'demo',
  task: 'T-1',
  slice: 'b',
  profile: 'bd-implementer',
  account: 'pool-x',
  cwd: `${CHECKOUT}/.worktrees/bd-t-1-b`,
  repo: CHECKOUT,
  agentName: 'bd-t-1-b',
  worktree: `${CHECKOUT}/.worktrees/bd-t-1-b`,
  reason: 'ready slice b',
  ...over,
})

function stepContext(): StepContext {
  const initiative: Initiative = {
    slug: 'demo',
    state: 'focused',
    autonomy: { mode: 'burndown', lanes: 1, accounts: [], grants: [], repo: CHECKOUT },
  }
  const task = { id: 'T-1', doneWhen: 'the slice works', tags: [] } as unknown as Task
  return {
    now: NOW,
    root: '/tmp/aw',
    initiatives: new Map([['demo', initiative]]),
    tasks: new Map([['demo', [task]]]),
    reportTo: 'coord',
    repoFacts: () => ({ defaultBranch: 'main' }),
    account: () => ({ account: 'pool-x' }),
    configDir: account => `/tmp/accounts/${account}`,
    trust: () => undefined,
    taskText: () => 'id: T-1',
    readFile: () => undefined,
    running: () => false,
  }
}

function dispatched(d: Dispatch): { claimPatch: Record<string, unknown>; frame: SpawnFrame } {
  const steps = stepsForDispatch(d, stepContext()) as Step[]
  const ledger = steps[0] as Extract<Step, { kind: 'ledger' }>
  const update = ledger.actions[0] as { patch: Record<string, unknown> }
  const spawn = steps[1] as Extract<Step, { kind: 'spawn' }>
  return { claimPatch: update.patch, frame: spawn.frame }
}

describe('dispatching a stacked slice', () => {
  it("cuts the worktree from origin's copy of the parent branch, where an unstacked slice names no base", () => {
    const stacked = dispatched(dispatch({ stackedOn: STACKED }))
    const unstacked = dispatched(dispatch())

    expect(stacked.frame.baseRef).toBe(`origin/${PARENT_BRANCH}`)
    expect(stacked.claimPatch.stackedOn).toEqual(STACKED)
    expect(unstacked.frame).not.toHaveProperty('baseRef')
    expect(unstacked.claimPatch).not.toHaveProperty('stackedOn')
    expect(unstacked.frame.brief).toContain('git merge --ff-only origin/main')
    expect(unstacked.frame.brief).not.toContain('--base ')
  })

  it('briefs the PR onto the parent branch, merges instead of rebasing, and registers after the parent', () => {
    const { brief } = dispatched(dispatch({ stackedOn: STACKED })).frame

    expect(brief).toContain(`gh pr create --base ${PARENT_BRANCH}`)
    expect(brief).toContain(`git merge origin/${PARENT_BRANCH}`)
    expect(brief).toContain('never rebase or force-push')
    expect(brief).toContain(`--after ${REPO_SLUG}#10`)
    expect(brief).not.toContain('git merge --ff-only origin/main')
  })
})

describe('a seat planning a stacked slice', () => {
  const seat: SeatDispatch = {
    seat: 'seat-a',
    prefix: 'sa',
    pool: { name: 'pool-x', human_uses: false, reserve_seven_day: 20, ceiling_five_hour: 80 },
    configDir: '/tmp/pool-x',
    repos: { demo: [CHECKOUT] },
    caps: { implementers: 2, reviewers: 1, planners: 1 },
    worktrees: { perRepoPerSeat: 3, capName: 'worktrees_per_repo_per_seat', leftFreePerRepo: 2 },
    excludedTags: [],
    grants: [],
  }
  const inSeat = { seat: 'seat-a', namePrefix: 'sa' }
  const ledger: Ledger = {
    version: 1,
    claims: [
      claim({ ...inSeat, slice: 'a', dependsOn: [], phase: 'shepherding', pr: PARENT_PR }),
      claim(inSeat),
    ],
  }
  const task = {
    id: 'T-1',
    title: 'stacked',
    status: 'open',
    priority: 1,
    estimate: 2,
    doneWhen: 'works',
    tags: [],
  }
  const checked: (StackedOn | undefined)[] = []
  const collision = (_repo: string, work: { stackedOn?: StackedOn }) => (
    checked.push(work.stackedOn),
    undefined
  )
  const plannedWith = (stack?: (child: Claim, dep: string) => StackedOn | undefined) =>
    planSeat({
      collision,
      seat,
      rows: [],
      defaults: { initiative_decay: 0.5, share_caps: {} } as never,
      tasks: new Map([['demo', [task as Task]]]),
      ledger,
      budget: {
        pool: seat.pool,
        spend: {},
        reading: { sevenDay: 40, fiveHour: 10, ageSeconds: 30 },
        history: [],
        runStartAt: NOW.getTime() - 3_600_000,
        ctx: { now: NOW },
      },
      ...(stack === undefined ? {} : { stack }),
    })

  it('dispatches the child onto its unmerged parent only with the stack predicate, telling collision its parent', () => {
    const stacked = plannedWith((_child, dep) => (dep === 'a' ? STACKED : undefined))

    expect(plannedWith().dispatch).toEqual([])
    expect(stacked.dispatch).toEqual([
      expect.objectContaining({ task: 'T-1', slice: 'b', stackedOn: STACKED }),
    ])
    expect(checked).toEqual([STACKED])
  })
})

describe('stackInputs', () => {
  const parent = claim({
    slice: 'a',
    dependsOn: [],
    phase: 'shepherding',
    pr: PARENT_PR,
    agentName: 'bd-t-1-a',
  })
  const ledger: Ledger = { version: 1, claims: [parent, claim()] }
  const rows: ShepherdRow[] = [
    {
      repo: REPO_SLUG,
      pr: 10,
      runId: 'run-10',
      phase: 'review',
      headSha: 'abc1234',
      stalled: null,
      held: null,
      branch: PARENT_BRANCH,
    },
  ]

  it('hands the planners a predicate that stacks the child under on', () => {
    const { stack, notes } = stackInputs('on', ledger, new Map(), () => rows)

    expect(stack?.(claim(), 'a')).toEqual(STACKED)
    expect(notes).toEqual([])
  })

  it('only notes the would-stack slice under shadow', () => {
    const { stack, notes } = stackInputs('shadow', ledger, new Map(), () => rows)

    expect(stack).toBeUndefined()
    expect(notes).toEqual([`would stack T-1 b on a ${PARENT_PR}`])
  })

  it('stacks nothing when the Shepherd status cannot be read', () => {
    const { stack, notes } = stackInputs('on', ledger, new Map(), () => undefined)

    expect(stack).toBeUndefined()
    expect(notes).toEqual(['stack on: shepherd status unread, so nothing stacks this tick'])
  })
})

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

/** A synthetic repo on a bare origin whose parent branch carries one commit main does not. */
function repoWithParentBranch(): { repo: string; parentTip: string } {
  const repo = tmpdir('stack-repo-')
  git(['init', '-b', 'main'], repo)
  git(['config', 'user.email', 'test@example.com'], repo)
  git(['config', 'user.name', 'Test'], repo)
  git(['config', 'commit.gpgsign', 'false'], repo)
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n')
  git(['add', '.'], repo)
  git(['commit', '-q', '-m', 'seed'], repo)
  const origin = tmpdir('stack-origin-')
  git(['init', '-q', '--bare', '-b', 'main'], origin)
  git(['remote', 'add', 'origin', origin], repo)
  git(['push', '-q', 'origin', 'main'], repo)
  git(['checkout', '-q', '-b', PARENT_BRANCH], repo)
  fs.writeFileSync(path.join(repo, 'parent.txt'), 'parent work\n')
  git(['add', '.'], repo)
  git(['commit', '-q', '-m', 'parent work'], repo)
  git(['push', '-q', 'origin', PARENT_BRANCH], repo)
  const parentTip = git(['rev-parse', 'HEAD'], repo)
  git(['checkout', '-q', 'main'], repo)
  git(['branch', '-q', '-D', PARENT_BRANCH], repo)
  return { repo, parentTip }
}

const ctxFor = (repo: string, baseRef?: string, agentName = 'bd-t-1-b'): IsolationContext => ({
  agentId: `id-${agentName}`,
  agentName,
  baseCwd: repo,
  ...(baseRef === undefined ? {} : { baseRef }),
})

/** No repo here declares a setup step; the runner only stands in so no real install could run. */
const noSetup: SetupRunner = async () => ({ exitCode: 0, timedOut: false, output: '' })

describe('the worktree of a stacked slice', () => {
  it("is cut from the fetched parent branch, while a spawn naming no base still gets origin's default", async () => {
    const { repo, parentTip } = repoWithParentBranch()
    const mainTip = git(['rev-parse', 'origin/main'], repo)
    const strategy = createWorktreeStrategy({ runSetup: noSetup })

    const alloc = await strategy.allocate(ctxFor(repo, `origin/${PARENT_BRANCH}`))
    const unstacked = await strategy.allocate(ctxFor(repo, undefined, 'bd-t-2'))

    expect(git(['rev-parse', 'HEAD'], alloc.cwd)).toBe(parentTip)
    expect(fs.existsSync(path.join(alloc.cwd, 'parent.txt'))).toBe(true)
    expect(alloc.ref).toMatchObject({ base: parentTip, base_ref: `origin/${PARENT_BRANCH}` })
    expect(git(['rev-parse', 'HEAD'], unstacked.cwd)).toBe(mainTip)
    expect(unstacked.ref).toMatchObject({ base: mainTip, base_ref: 'origin/main' })
  })

  it('is refused rather than cut from the default branch when the parent branch is gone', async () => {
    const { repo } = repoWithParentBranch()
    const strategy = createWorktreeStrategy({ runSetup: noSetup })

    await expect(strategy.allocate(ctxFor(repo, 'origin/agent-chat/bd-gone'))).rejects.toThrow(
      'fetching base origin/agent-chat/bd-gone failed or timed out',
    )
    expect(fs.existsSync(path.join(repo, '.worktrees', 'bd-t-1-b'))).toBe(false)
  })

  it('refuses a base that is not an origin branch', async () => {
    const { repo } = repoWithParentBranch()
    const strategy = createWorktreeStrategy({ runSetup: noSetup })

    await expect(strategy.allocate(ctxFor(repo, '--upload-pack=x'))).rejects.toThrow(
      'is not a branch on origin',
    )
  })
})

describe('executing a stacked claim', () => {
  const ledgerFile = (): string => path.join(tmpdir('stack-ledger-'), 'ledger.json')
  const deps = (over: Partial<ExecuteDeps>): ExecuteDeps => ({
    ledgerFile: ledgerFile(),
    spawn: async () => ({ ok: true }),
    retire: async () => ({ ok: true }),
    register: () => ({ ok: true }),
    log: () => {},
    now: NOW,
    ...over,
  })

  it('registers with Shepherd after the parent PR, named from the claim', async () => {
    const calls: string[][] = []
    const exec: Runner = (_bin, args) => {
      calls.push([...args])
      if (args[1] === 'status') return { status: 0, stdout: '[]' }
      if (args[0] === 'api') return { status: 1, stdout: '' }
      return { status: 0, stdout: '' }
    }
    const child = claim({ phase: 'shepherding', pr: `${REPO_SLUG}#11`, stackedOn: STACKED })
    const step: Step = {
      kind: 'register',
      key: { taskId: 'T-1', slice: 'b' },
      registration: { target: { repo: REPO_SLUG, pr: 11 }, task: 'demo/T-1', implementer: 'bd-t-1-b' },
    }

    await execute(
      [step],
      { version: 1, claims: [child] },
      deps({ register: r => registerWithShepherd(r, exec, () => {}) }),
    )

    const register = calls.find(c => c[1] === 'register')
    expect(register).toEqual(expect.arrayContaining(['--after', `${REPO_SLUG}#10`]))
  })

  it("records the parent head the child's worktree was cut from", async () => {
    const child = claim({ phase: 'spawning', agentName: 'bd-t-1-b', stackedOn: STACKED })
    const frame = {
      name: 'bd-t-1-b',
      profile: 'bd-implementer',
      brief: 'b',
      baseRef: `origin/${PARENT_BRANCH}`,
    }
    const step = { kind: 'spawn', key: { taskId: 'T-1', slice: 'b' }, frame } as unknown as Step
    const base = { ref: `origin/${PARENT_BRANCH}`, sha: 'f'.repeat(40) }

    const done = await execute(
      [step],
      { version: 1, claims: [child] },
      deps({ spawn: async () => ({ ok: true, agentId: 'a1', base }) }),
    )

    expect(done.ledger.claims[0]?.stackedOn).toEqual({ ...STACKED, forkHead: 'f'.repeat(40) })
  })

  it('says so, and records no fork head, when a broker predating baseRef cuts from the default branch', async () => {
    const child = claim({ phase: 'spawning', agentName: 'bd-t-1-b', stackedOn: STACKED })
    const frame = {
      name: 'bd-t-1-b',
      profile: 'bd-implementer',
      brief: 'b',
      baseRef: `origin/${PARENT_BRANCH}`,
    }
    const step = { kind: 'spawn', key: { taskId: 'T-1', slice: 'b' }, frame } as unknown as Step
    const base = { ref: 'origin/main', sha: 'e'.repeat(40) }

    const done = await execute(
      [step],
      { version: 1, claims: [child] },
      deps({ spawn: async () => ({ ok: true, agentId: 'a1', base }) }),
    )

    expect(done.ledger.claims[0]?.stackedOn).toEqual(STACKED)
    expect(done.lines[0]).toContain(`base origin/${PARENT_BRANCH} not honoured (cut from origin/main)`)
  })
})

describe('the port spawn frame', () => {
  const frame = {
    t: 'spawn',
    name: 'bd-t-1-b',
    profile: 'bd-implementer',
    brief: 'b',
    cwd: CHECKOUT,
    configDir: '/tmp/pool-x',
    surface: 'headless',
    briefing: 'demo',
    tags: ['burndown'],
    task: 'T-1',
    spawnedAs: 'burndown',
  }

  it('takes a base from a new tick and still takes a frame without one from an old tick', () => {
    expect(PortSpawnFrame.safeParse({ ...frame, baseRef: `origin/${PARENT_BRANCH}` }).success).toBe(true)
    expect(PortSpawnFrame.safeParse(frame).success).toBe(true)
  })
})
