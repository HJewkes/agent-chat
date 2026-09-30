import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { openServices } from '../broker/daemon.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor } from '../agents/supervisor.js'
import { RECLAIM_GRACE_MS } from '../agents/isolation/worktree.js'
import {
  retireFinished,
  SCOPE_REQUIRED,
  type FinishedRetirePort,
} from '../agents/isolation/retire-finished.js'
import type { AgentIdentity, ServerMessage } from '../protocol.js'
import { autoAttach } from './broker-harness.js'

/**
 * CC-323: `agent retire --finished` retires every finished agent in scope that
 * holds no work, through the same `Supervisor.retire` a single-name retire uses.
 */

const tmpDirs: string[] = []
let core: BrokerCore
let sup: Supervisor
let stopAutoAttach: () => void

const tmp = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpDirs.push(dir)
  return dir
}

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

function makeRepo(): string {
  const dir = tmp('bulk-repo-')
  git(['init', '-b', 'main'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  git(['config', 'user.name', 'Test'], dir)
  git(['config', 'commit.gpgsign', 'false'], dir)
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n')
  git(['add', '.'], dir)
  git(['commit', '-m', 'seed'], dir)
  return dir
}

/** A push made as a fetch from the bare side, so a machine-wide pre-push hook cannot fail the fixture. */
function publish(dir: string, branch: string, track = false): void {
  const origin = git(['remote', 'get-url', 'origin'], dir)
  git(['fetch', '-q', dir, `${branch}:${branch}`], origin)
  git(['fetch', '-q', 'origin'], dir)
  if (track) git(['branch', '-q', `--set-upstream-to=origin/${branch}`, branch], dir)
}

function repoWithOrigin(): string {
  const repo = makeRepo()
  const origin = tmp('bulk-origin-')
  git(['init', '--bare', '-b', 'main'], origin)
  git(['remote', 'add', 'origin', origin], repo)
  publish(repo, 'main')
  return repo
}

const commitIn = (dir: string, file: string): void => {
  fs.writeFileSync(path.join(dir, file), 'work\n')
  git(['add', file], dir)
  git(['commit', '-m', `add ${file}`], dir)
}

async function spawnIn(
  name: string,
  repo: string,
  over: Record<string, unknown> = {},
): Promise<AgentIdentity> {
  const spawned = await sup.spawn({
    name,
    profile: 'explorer',
    brief: 'do the task',
    requestedBy: 'coord-a',
    cwd: repo,
    isolation: 'worktree' as const,
    surface: 'headless' as const,
    spawnerConfigDir: tmp('bulk-account-'),
    ...over,
  })
  expect(spawned.reason).toBeUndefined()
  return core.agents.get(spawned.agentId as string)!
}

async function exit(agent: AgentIdentity): Promise<void> {
  const recordExit = (sup as unknown as { recordExit: (id: string, o: unknown) => Promise<void> }).recordExit
  await recordExit.call(sup, agent.agentId, { code: 0, signal: null })
}

/** Past the reclaim grace window, so the retire's own release does not refuse on time alone. */
const pastGrace = (): void => void vi.setSystemTime(Date.now() + RECLAIM_GRACE_MS + 1_000)

async function finishedIn(name: string, repo: string): Promise<AgentIdentity> {
  const agent = await spawnIn(name, repo)
  await exit(agent)
  return agent
}

const stateOf = (name: string): string | undefined =>
  core.agents.roster({ includeRetired: true }).findLast(a => a.name === name)?.state

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const home = tmp('bulk-home-')
  process.env.AGENT_CHAT_HOME = home
  fs.writeFileSync(path.join(home, 'config.json'), '{"worktreeBudget": 12}')
  const events = new EventLog(path.join(home, 'events.db'))
  core = new BrokerCore(() => undefined, { events, registry: new Registry<Conn>() })
  stopAutoAttach = autoAttach(core)
  sup = new Supervisor(core, {
    surface: {
      platform: 'linux',
      spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }),
    },
  })
})

afterEach(() => {
  stopAutoAttach()
  sup.close()
  vi.useRealTimers()
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('the skip rules', () => {
  // Kills: liveBlocker returning undefined for a live agent.
  it('skips a live agent and leaves it running', async () => {
    await spawnIn('cc-live', makeRepo())
    await vi.waitFor(() => expect(stateOf('cc-live')).toBe('live'))

    const out = await sup.retireFinished({ prefix: 'cc-' })

    expect(out.plan).toEqual([{ name: 'cc-live', action: 'skip', reason: 'live' }])
    expect(out.results).toEqual([])
    expect(stateOf('cc-live')).toBe('live')
  })

  // Kills: `uncommitted` reporting a non-empty `git status --porcelain` as clean.
  it('skips a tree with uncommitted changes', async () => {
    const agent = await finishedIn('cc-dirty', makeRepo())
    fs.writeFileSync(path.join(agent.cwd, 'draft.txt'), 'unsaved\n')
    pastGrace()

    const out = await sup.retireFinished({ prefix: 'cc-' })

    expect(out.plan[0]).toMatchObject({ action: 'skip', reason: `uncommitted changes in ${agent.cwd}` })
    expect(fs.existsSync(path.join(agent.cwd, 'draft.txt'))).toBe(true)
  })

  // Kills M2 and M19: a status read that leaves out ignored-but-tracked or untracked files.
  it('skips a tree whose only change is a tracked file that .gitignore also matches', async () => {
    const repo = makeRepo()
    fs.writeFileSync(path.join(repo, 'kept.log'), 'v1\n')
    git(['add', '-f', 'kept.log'], repo)
    fs.writeFileSync(path.join(repo, '.gitignore'), '*.log\n')
    git(['add', '.gitignore'], repo)
    git(['commit', '-m', 'track an ignored file'], repo)
    const agent = await finishedIn('cc-ignored', repo)
    fs.writeFileSync(path.join(agent.cwd, 'kept.log'), 'v2\n')
    pastGrace()

    const out = await sup.retireFinished({ prefix: 'cc-' })

    expect(out.plan[0]).toMatchObject({ action: 'skip', reason: `uncommitted changes in ${agent.cwd}` })
  })

  it('skips an untracked file even when status.showUntrackedFiles is off', async () => {
    const repo = makeRepo()
    git(['config', 'status.showUntrackedFiles', 'no'], repo)
    const agent = await finishedIn('cc-untracked', repo)
    fs.writeFileSync(path.join(agent.cwd, 'new.ts'), 'x\n')
    pastGrace()

    const out = await sup.retireFinished({ prefix: 'cc-' })

    expect(out.plan[0]).toMatchObject({ action: 'skip', reason: `uncommitted changes in ${agent.cwd}` })
  })

  // Kills: `unpushed` ignoring a non-empty `git rev-list @{u}..HEAD`.
  it('skips a tree with commits ahead of its upstream', async () => {
    const agent = await spawnIn('cc-ahead', repoWithOrigin())
    commitIn(agent.cwd, 'one.ts')
    publish(agent.cwd, 'agent-chat/cc-ahead', true)
    commitIn(agent.cwd, 'two.ts')
    await exit(agent)
    pastGrace()

    const out = await sup.retireFinished({ prefix: 'cc-' })

    expect(out.plan[0]).toMatchObject({
      action: 'skip',
      reason: `1 commit(s) in ${agent.cwd} are not on upstream origin/agent-chat/cc-ahead`,
    })
    expect(stateOf('cc-ahead')).toBe('exited')
  })

  // Kills: treating a branch with no upstream as pushed instead of comparing it with the default branch.
  it('skips a branch with no upstream that holds commits not on the default branch', async () => {
    const agent = await spawnIn('cc-local', makeRepo())
    commitIn(agent.cwd, 'feature.ts')
    await exit(agent)
    pastGrace()

    const out = await sup.retireFinished({ prefix: 'cc-' })

    expect(out.plan[0]).toMatchObject({
      action: 'skip',
      reason: `1 commit(s) in ${agent.cwd} are not on the default branch main (no upstream)`,
    })
  })

  // Kills: adopterBlocker returning undefined while an unretired agent works in the tree (CC-141).
  it('skips an agent whose worktree an unretired adopter still works in', async () => {
    const owner = await finishedIn('cc-owner', makeRepo())
    await spawnIn('heir', owner.cwd, { worktree: owner.cwd, isolation: 'worktree' })
    pastGrace()

    const out = await sup.retireFinished({ prefix: 'cc-' })

    expect(out.plan).toEqual([
      { name: 'cc-owner', action: 'skip', reason: 'heir (not retired) still works in its worktree' },
    ])
    expect(fs.existsSync(owner.cwd)).toBe(true)
  })

  // Kills: `uncommitted` treating a failed `git status` as a clean tree.
  it('skips a tree git cannot read, and says so', async () => {
    const agent = await finishedIn('cc-broken', makeRepo())
    fs.writeFileSync(path.join(agent.cwd, '.git'), 'gitdir: /nonexistent/gitdir\n')
    pastGrace()

    const out = await sup.retireFinished({ prefix: 'cc-' })

    expect(out.plan[0]).toMatchObject({ action: 'skip', reason: `could not read git status in ${agent.cwd}` })
    expect(stateOf('cc-broken')).toBe('exited')
  })

  it('retires a branch pushed without -u, since origin/<branch> holds its commits', async () => {
    const agent = await spawnIn('cc-pushed', repoWithOrigin())
    commitIn(agent.cwd, 'feature.ts')
    publish(agent.cwd, 'agent-chat/cc-pushed')
    await exit(agent)
    pastGrace()

    const out = await sup.retireFinished({ prefix: 'cc-' })

    expect(out.plan).toEqual([{ name: 'cc-pushed', action: 'retire' }])
    expect(out.results).toEqual([{ name: 'cc-pushed', ok: true }])
  })
})

describe('a mixed set', () => {
  it('retires the clean finished agents, skips the rest, and never touches another scope', async () => {
    const repo = makeRepo()
    const clean = await finishedIn('cc-clean', repo)
    const dirty = await finishedIn('cc-dirty', repo)
    fs.writeFileSync(path.join(dirty.cwd, 'draft.txt'), 'unsaved\n')
    await spawnIn('cc-live', repo)
    await finishedIn('other-clean', repo)
    await vi.waitFor(() => expect(stateOf('cc-live')).toBe('live'))
    pastGrace()

    const out = await sup.retireFinished({ prefix: 'cc-' })

    expect(out.plan.map(e => [e.name, e.action])).toEqual([
      ['cc-clean', 'retire'],
      ['cc-dirty', 'skip'],
      ['cc-live', 'skip'],
    ])
    expect(out).toMatchObject({ ok: true, results: [{ name: 'cc-clean', ok: true }] })
    expect(fs.existsSync(clean.cwd)).toBe(false)
    expect([stateOf('cc-dirty'), stateOf('cc-live'), stateOf('other-clean')]).toEqual([
      'exited',
      'live',
      'exited',
    ])
  })

  it('scopes by spawner', async () => {
    const repo = makeRepo()
    await finishedIn('mine', repo)
    const theirs = await spawnIn('theirs', repo, { requestedBy: 'coord-b' })
    await exit(theirs)
    pastGrace()

    const out = await sup.retireFinished({ spawner: 'coord-a' })

    expect(out.plan).toEqual([{ name: 'mine', action: 'retire' }])
    expect(stateOf('theirs')).toBe('exited')
  })
})

describe('scope and dry run', () => {
  // Kills: dropping the early refusal, which would answer ok with an empty plan.
  it('refuses a call with neither --spawner nor --prefix, and retires nothing', async () => {
    await finishedIn('cc-clean', makeRepo())
    pastGrace()

    const out = await sup.retireFinished({ prefix: ' ' })

    expect(out).toEqual({ ok: false, reason: SCOPE_REQUIRED, plan: [], results: [] })
    expect(stateOf('cc-clean')).toBe('exited')
  })

  // Kills: ignoring dryRun and retiring the planned agents.
  it('changes nothing on a dry run', async () => {
    const agent = await finishedIn('cc-clean', makeRepo())
    pastGrace()
    const rowsBefore = core.events.agentEvents().length

    const out = await sup.retireFinished({ prefix: 'cc-', dryRun: true })

    expect(out).toEqual({ ok: true, plan: [{ name: 'cc-clean', action: 'retire' }], results: [] })
    expect(stateOf('cc-clean')).toBe('exited')
    expect(fs.existsSync(agent.cwd)).toBe(true)
    expect(core.events.agentEvents()).toHaveLength(rowsBefore)
  })
})

describe('a failed retire', () => {
  // Kills: stopping the loop at the first failed result.
  it('does not stop the rest, and is reported', async () => {
    const repo = makeRepo()
    const recent = await spawnIn('cc-a-recent', repo)
    const older = await finishedIn('cc-b-older', repo)
    pastGrace()
    await exit(recent)

    const out = await sup.retireFinished({ prefix: 'cc-' })

    expect(out.plan.map(e => e.action)).toEqual(['retire', 'retire'])
    expect(out.ok).toBe(false)
    expect(out.results).toEqual([
      { name: 'cc-a-recent', ok: false, reason: expect.stringMatching(/reclaim grace window/) },
      { name: 'cc-b-older', ok: true },
    ])
    expect(fs.existsSync(older.cwd)).toBe(false)
    expect(stateOf('cc-a-recent')).toBe('exited')
  })
})

describe('the broker frame', () => {
  it('answers retire_finished with the plan, and each result with its retire caveat', async () => {
    process.env.AGENT_CHAT_HOME = tmp('bulk-services-')
    const services = openServices(true)
    try {
      services.core.append({
        kind: 'agent_spawned',
        actor: 'coord-a',
        target: 'cc-done',
        msgId: 'a1',
        body: 'w',
      })
      services.core.append({ kind: 'agent_exited', actor: 'cc-done', ref: 'a1', meta: { code: '0' } })
      const frames: ServerMessage[] = []
      const conn = {
        write: (line: string) => frames.push(JSON.parse(line) as ServerMessage),
      } as unknown as Conn

      services.socketServer.handleMessage(conn, { t: 'retire_finished', prefix: 'cc-' })
      await expect.poll(() => frames.length).toBe(1)

      expect(frames[0]).toEqual({
        t: 'retire_finished_result',
        ok: true,
        plan: [{ name: 'cc-done', action: 'retire' }],
        results: [
          { name: 'cc-done', ok: true, reason: expect.stringMatching(/no record of what cc-done held/) },
        ],
      })
    } finally {
      services.socketServer.close()
      services.core.close()
    }
  })

  it.each([
    ['prefix 5', { prefix: 5 }],
    ['spawner an object', { spawner: { x: 1 } }],
    ['dryRun a string', { prefix: 'cc-', dryRun: 'yes' }],
  ])('replies ok:false to a malformed frame (%s) and keeps answering', async (_label, fields) => {
    process.env.AGENT_CHAT_HOME = tmp('bulk-services-')
    const services = openServices(true)
    try {
      const frames: ServerMessage[] = []
      const conn = {
        write: (line: string) => frames.push(JSON.parse(line) as ServerMessage),
      } as unknown as Conn

      services.socketServer.handleMessage(conn, { t: 'retire_finished', ...fields } as never)
      await expect.poll(() => frames.length).toBe(1)
      services.socketServer.handleMessage(conn, { t: 'retire_finished', prefix: 'cc-' })
      await expect.poll(() => frames.length).toBe(2)

      expect(frames[0]).toMatchObject({ t: 'retire_finished_result', ok: false, plan: [], results: [] })
      expect(frames[1]).toMatchObject({ t: 'retire_finished_result', ok: true })
    } finally {
      services.socketServer.close()
      services.core.close()
    }
  })
})

describe('the recheck and parking rules, against a fake port', () => {
  const agent = (name: string, over: Partial<AgentIdentity> = {}): AgentIdentity =>
    ({
      agentId: `id-${name}`,
      name,
      state: 'exited',
      origin: 'spawned',
      spawnedBy: 'coord-a',
      cwd: '',
      ...over,
    }) as AgentIdentity

  function portFor(roster: AgentIdentity[], over: Partial<FinishedRetirePort> = {}): FinishedRetirePort {
    return {
      roster: () => roster,
      events: () => [],
      tracked: () => false,
      parking: () => false,
      current: id => roster.find(a => a.agentId === id),
      retire: () => Promise.resolve({ ok: true }),
      ...over,
    }
  }

  // Kills M9: dropping the liveness recheck before each retire.
  it('refuses to retire an agent that went live after the plan', async () => {
    const first = agent('cc-1')
    const second = agent('cc-2')
    const retired: string[] = []
    const port = portFor([first, second], {
      retire: name => {
        retired.push(name)
        second.state = 'live'
        return Promise.resolve({ ok: true })
      },
    })

    const out = await retireFinished(port, { prefix: 'cc-' })

    expect(retired).toEqual(['cc-1'])
    expect(out.results[1]).toEqual({ name: 'cc-2', ok: false, reason: 'became live after the plan' })
  })

  // Kills M10: dropping the identity recheck before each retire.
  it('refuses to retire when the name now belongs to another agent', async () => {
    const first = agent('cc-1')
    const port = portFor([first], {
      current: () => agent('cc-other', { agentId: first.agentId }),
    })

    const out = await retireFinished(port, { prefix: 'cc-' })

    expect(out.results).toEqual([{ name: 'cc-1', ok: false, reason: 'no longer the agent the plan named' }])
  })

  // Kills M4 and M20: ignoring the parking state, in the plan or by reading the wrong id.
  it('skips only the agent that is being parked', async () => {
    const parked = agent('cc-parked')
    const other = agent('cc-other')
    const port = portFor([parked, other], { parking: id => id === parked.agentId })

    const out = await retireFinished(port, { prefix: 'cc-', dryRun: true })

    expect(out.plan).toEqual([
      { name: 'cc-parked', action: 'skip', reason: 'being parked' },
      { name: 'cc-other', action: 'retire' },
    ])
  })
})
