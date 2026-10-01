import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor } from '../agents/supervisor.js'
import { readLaunchPlan } from '../agents/launch-files.js'
import { transcriptPath } from '../agents/transcript.js'
import { worktreeStrategy } from '../agents/isolation/worktree.js'
import { seatLogPath } from '../agents/seats/io.js'
import { seatJournal } from '../agents/seats/journal.js'
import type { AgentIdentity } from '../protocol.js'
import { autoAttach } from './broker-harness.js'

/**
 * CC-282: `agent park` removes an exited agent's clean, pushed worktree and keeps
 * its branch, so `agent resume` re-creates the tree at the same path (CC-140).
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
  const dir = tmp('park-repo-')
  git(['init', '-b', 'main'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  git(['config', 'user.name', 'Test'], dir)
  git(['config', 'commit.gpgsign', 'false'], dir)
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n')
  git(['add', '.'], dir)
  git(['commit', '-m', 'seed'], dir)
  return dir
}

function repoWithOrigin(): string {
  const repo = makeRepo()
  const origin = tmp('park-origin-')
  git(['init', '--bare', '-b', 'main'], origin)
  git(['remote', 'add', 'origin', origin], repo)
  git(['push', '-q', 'origin', 'main'], repo)
  return repo
}

const commitIn = (dir: string, file: string): string => {
  fs.writeFileSync(path.join(dir, file), 'work\n')
  git(['add', file], dir)
  git(['commit', '-m', `add ${file}`], dir)
  return git(['rev-parse', 'HEAD'], dir)
}

const branchHead = (repo: string, branch: string): string => git(['rev-parse', '--verify', branch], repo)

const treesUnder = (repo: string): number =>
  git(['worktree', 'list', '--porcelain'], repo)
    .split('\n')
    .filter(line => line.startsWith(`worktree ${path.join(repo, '.worktrees')}${path.sep}`)).length

const spawnReq = (name: string, repo: string, over: Record<string, unknown> = {}) => ({
  name,
  profile: 'explorer',
  brief: 'do the task',
  requestedBy: 'human',
  cwd: repo,
  isolation: 'worktree' as const,
  surface: 'headless' as const,
  spawnerConfigDir: tmp('park-account-'),
  ...over,
})

async function spawnIn(
  name: string,
  repo: string,
  over: Record<string, unknown> = {},
): Promise<AgentIdentity> {
  const spawned = await sup.spawn(spawnReq(name, repo, over))
  expect(spawned.reason).toBeUndefined()
  const agent = core.agents.get(spawned.agentId as string)!
  const transcript = transcriptPath(agent.cwd, agent.sessionId, agent.configDir)
  fs.mkdirSync(path.dirname(transcript), { recursive: true })
  fs.writeFileSync(transcript, '{}\n')
  return agent
}

async function exit(agent: AgentIdentity): Promise<void> {
  const recordExit = (sup as unknown as { recordExit: (id: string, o: unknown) => Promise<void> }).recordExit
  await recordExit.call(sup, agent.agentId, { code: 0, signal: null })
}

async function finishedIn(
  name: string,
  repo: string,
  over: Record<string, unknown> = {},
): Promise<AgentIdentity> {
  const agent = await spawnIn(name, repo, over)
  await exit(agent)
  return agent
}

const parkedRows = (agentId: string) =>
  core.events.agentEvents().filter(r => r.kind === 'isolation_parked' && r.ref === agentId)

beforeEach(() => {
  const home = tmp('park-home-')
  process.env.AGENT_CHAT_HOME = home
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
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('parking a finished agent', () => {
  it('removes a pushed tree, keeps the branch, and resume brings it back at the same path on the pushed head', async () => {
    const repo = repoWithOrigin()
    const agent = await spawnIn('worker-a', repo)
    const pushed = commitIn(agent.cwd, 'feature.ts')
    git(['push', '-q', 'origin', 'agent-chat/worker-a'], agent.cwd)
    await exit(agent)

    const parked = await sup.park('worker-a')

    expect(parked).toMatchObject({ ok: true })
    expect(fs.existsSync(agent.cwd)).toBe(false)
    expect(branchHead(repo, 'agent-chat/worker-a')).toBe(pushed)
    expect(parkedRows(agent.agentId).at(-1)?.meta).toMatchObject({ worktree: agent.cwd, head: pushed })

    const resumed = await sup.resume('worker-a')

    expect(resumed.reason).toBeUndefined()
    expect(readLaunchPlan(agent.agentId).cwd).toBe(agent.cwd)
    expect(git(['rev-parse', 'HEAD'], agent.cwd)).toBe(pushed)
  })

  it('keeps the local branch in a repository with no remote', async () => {
    const repo = makeRepo()
    const agent = await spawnIn('worker-a', repo)
    const committed = commitIn(agent.cwd, 'feature.ts')
    await exit(agent)

    const parked = await sup.park('worker-a')

    expect(parked.ok).toBe(true)
    expect(fs.existsSync(agent.cwd)).toBe(false)
    expect(branchHead(repo, 'agent-chat/worker-a')).toBe(committed)
  })

  it('drops the repository worktree count by one, freeing a budget slot', async () => {
    const repo = makeRepo()
    await finishedIn('worker-a', repo)
    fs.writeFileSync(path.join(process.env.AGENT_CHAT_HOME!, 'config.json'), '{"worktreeBudget": 1}')
    const other = { agentId: 'other', agentName: 'other', baseCwd: repo }
    await expect(worktreeStrategy.allocate(other)).rejects.toThrow(/budget exhausted/i)
    const before = treesUnder(repo)

    expect((await sup.park('worker-a')).ok).toBe(true)

    expect(treesUnder(repo)).toBe(before - 1)
    await expect(worktreeStrategy.allocate(other)).resolves.toMatchObject({
      ref: { branch: 'agent-chat/other' },
    })
  })
})

describe('re-creating a parked tree a successor adopts (CC-283)', () => {
  async function parkedPushed(repo: string): Promise<{ tree: string; pushed: string }> {
    const predecessor = await spawnIn('worker-a', repo)
    const pushed = commitIn(predecessor.cwd, 'feature.ts')
    git(['push', '-q', 'origin', 'agent-chat/worker-a'], predecessor.cwd)
    await exit(predecessor)
    expect((await sup.park('worker-a')).ok).toBe(true)
    return { tree: predecessor.cwd, pushed }
  }

  const allocatedRows = (agentId: string) =>
    core.events.agentEvents().filter(r => r.kind === 'isolation_allocated' && r.ref === agentId)

  it('spawns a successor on a parked predecessor tree, re-created at its path on the pushed branch tip', async () => {
    const repo = repoWithOrigin()
    const { tree, pushed } = await parkedPushed(repo)
    git(['commit', '-q', '--allow-empty', '-m', 'main moved on'], repo)

    const spawned = await sup.spawn(spawnReq('worker-b', repo, { worktree: tree }))

    expect(spawned.reason).toBeUndefined()
    expect(readLaunchPlan(spawned.agentId as string).cwd).toBe(tree)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], tree)).toBe('agent-chat/worker-a')
    expect(git(['rev-parse', 'HEAD'], tree)).toBe(pushed)
    expect(allocatedRows(spawned.agentId as string).at(-1)?.meta).toMatchObject({
      worktree: tree,
      assigned: 'true',
    })
  })

  it('resumes a successor whose adopted tree was parked, re-created at its path on the pushed branch tip', async () => {
    const repo = repoWithOrigin()
    const predecessor = await spawnIn('worker-a', repo)
    const pushed = commitIn(predecessor.cwd, 'feature.ts')
    git(['push', '-q', 'origin', 'agent-chat/worker-a'], predecessor.cwd)
    await exit(predecessor)
    const successor = await finishedIn('worker-b', repo, { worktree: predecessor.cwd })
    git(['worktree', 'remove', predecessor.cwd], repo)

    const resumed = await sup.resume('worker-b')

    expect(resumed.reason).toBeUndefined()
    expect(readLaunchPlan(successor.agentId).cwd).toBe(predecessor.cwd)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], predecessor.cwd)).toBe('agent-chat/worker-a')
    expect(git(['rev-parse', 'HEAD'], predecessor.cwd)).toBe(pushed)
    expect(allocatedRows(successor.agentId).at(-1)?.meta).toMatchObject({ assigned: 'true' })
  })

  it('leaves the re-created tree in place when the successor retires', async () => {
    const repo = repoWithOrigin()
    const { tree } = await parkedPushed(repo)
    await sup.spawn(spawnReq('worker-b', repo, { worktree: tree }))

    const retired = await sup.retire('worker-b')

    expect(retired.reason).toBeUndefined()
    expect(fs.existsSync(tree)).toBe(true)
    expect(branchHead(repo, 'agent-chat/worker-a')).toBeTruthy()
  })

  it('counts the re-created tree once against the worktree budget', async () => {
    const repo = repoWithOrigin()
    const { tree } = await parkedPushed(repo)
    fs.writeFileSync(path.join(process.env.AGENT_CHAT_HOME!, 'config.json'), '{"worktreeBudget": 1}')

    const spawned = await sup.spawn(spawnReq('worker-b', repo, { worktree: tree }))

    expect(spawned.reason).toBeUndefined()
    expect(treesUnder(repo)).toBe(1)
    const other = { agentId: 'other', agentName: 'other', baseCwd: repo }
    await expect(worktreeStrategy.allocate(other)).rejects.toThrow(/budget exhausted: 1\/1/i)
  })

  it('refuses an assigned path agent-chat never allocated, creating nothing', async () => {
    const repo = makeRepo()
    const invented = path.join(repo, '.worktrees', 'never-made')

    const spawned = await sup.spawn(spawnReq('worker-b', repo, { worktree: invented }))

    expect(spawned).toMatchObject({
      ok: false,
      reason: expect.stringMatching(
        /assigned worktree .* does not exist, and agent-chat has no record of allocating it/,
      ),
    })
    expect(fs.existsSync(invented)).toBe(false)
  })

  it('refuses to re-create an adopted tree whose branch is gone rather than fork a fresh one', async () => {
    const repo = makeRepo()
    const predecessor = await finishedIn('worker-a', repo)
    expect((await sup.park('worker-a')).ok).toBe(true)
    git(['branch', '-D', 'agent-chat/worker-a'], repo)

    const spawned = await sup.spawn(spawnReq('worker-b', repo, { worktree: predecessor.cwd }))

    expect(spawned).toMatchObject({
      ok: false,
      reason: expect.stringMatching(
        /branch agent-chat\/worker-a no longer exists .* not re-created on a fresh one/,
      ),
    })
    expect(fs.existsSync(predecessor.cwd)).toBe(false)
  })
})

describe('parking a seat’s agent (CC-316)', () => {
  const at = new Date(2026, 1, 3, 4, 5)
  let root: string

  beforeEach(() => {
    root = tmp('park-autonomy-')
    fs.mkdirSync(path.join(root, 'seats'))
    fs.writeFileSync(path.join(root, 'seats', 'seat-x.md'), '---\nprefix: sx\npool: pool-a\n---\n')
    sup.close()
    sup = new Supervisor(core, {
      surface: {
        platform: 'linux',
        spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }),
      },
      seatJournal: seatJournal(root, { now: () => at }),
    })
  })

  const journal = (): string => fs.readFileSync(seatLogPath(root, 'seat-x', at), 'utf8')

  it('writes one park line to the seat’s journal after the spawn line', async () => {
    await finishedIn('sx-ab-12-fix', makeRepo())

    const parked = await sup.park('sx-ab-12-fix')

    expect(parked.ok).toBe(true)
    expect(journal()).toBe('04:05 spawn AB-12 sx-ab-12-fix -\n04:05 park AB-12 sx-ab-12-fix -\n')
  })

  it('writes no park line when the park is refused', async () => {
    const agent = await finishedIn('sx-ab-12-fix', makeRepo())
    fs.writeFileSync(path.join(agent.cwd, 'scratch.txt'), 'unsaved\n')

    const parked = await sup.park('sx-ab-12-fix')

    expect(parked.ok).toBe(false)
    expect(journal()).toBe('04:05 spawn AB-12 sx-ab-12-fix -\n')
  })

  it('writes no retire line when the retire is refused for uncommitted work', async () => {
    const agent = await spawnIn('sx-ab-12-fix', makeRepo())
    fs.writeFileSync(path.join(agent.cwd, 'scratch.txt'), 'unsaved\n')

    const retired = await sup.retire('sx-ab-12-fix')

    expect(retired.reason).toMatch(/refused release/)
    expect(journal()).toBe('04:05 spawn AB-12 sx-ab-12-fix -\n')
  })
})

describe('refusing to park', () => {
  it('refuses a tree with uncommitted changes and leaves it', async () => {
    const agent = await finishedIn('worker-a', makeRepo())
    fs.writeFileSync(path.join(agent.cwd, 'scratch.txt'), 'draft\n')

    const parked = await sup.park('worker-a')

    expect(parked).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/uncommitted or untracked changes/),
    })
    expect(fs.existsSync(agent.cwd)).toBe(true)
    expect(parkedRows(agent.agentId)).toHaveLength(0)
  })

  it('refuses a branch that was never pushed to origin', async () => {
    const agent = await spawnIn('worker-a', repoWithOrigin())
    commitIn(agent.cwd, 'feature.ts')
    await exit(agent)

    const parked = await sup.park('worker-a')

    expect(parked).toMatchObject({ ok: false, reason: expect.stringMatching(/not on origin; push it first/) })
    expect(fs.existsSync(agent.cwd)).toBe(true)
  })

  it('refuses commits made after the last push', async () => {
    const agent = await spawnIn('worker-a', repoWithOrigin())
    commitIn(agent.cwd, 'feature.ts')
    git(['push', '-q', 'origin', 'agent-chat/worker-a'], agent.cwd)
    commitIn(agent.cwd, 'more.ts')
    await exit(agent)

    const parked = await sup.park('worker-a')

    expect(parked).toMatchObject({ ok: false, reason: expect.stringMatching(/1 commit\(s\).*not on origin/) })
    expect(fs.existsSync(agent.cwd)).toBe(true)
  })

  it('refuses an agent that is still live', async () => {
    const agent = await spawnIn('worker-a', makeRepo())

    const parked = await sup.park('worker-a')

    expect(parked).toMatchObject({ ok: false, reason: expect.stringMatching(/worker-a is (live|spawning)/) })
    expect(fs.existsSync(agent.cwd)).toBe(true)
  })

  it('refuses a tree a live successor occupies, naming the successor', async () => {
    const predecessor = await finishedIn('worker-a', makeRepo())
    await spawnIn('worker-b', predecessor.cwd, { isolation: 'worktree', worktree: predecessor.cwd })

    const parked = await sup.park('worker-a')

    expect(parked).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^worker-b is (live|spawning) in /),
    })
    expect(fs.existsSync(predecessor.cwd)).toBe(true)
  })

  it('refuses a finished successor on an adopted tree whose predecessor is not retired, naming the predecessor', async () => {
    const predecessor = await finishedIn('worker-a', makeRepo())
    await finishedIn('worker-b', predecessor.cwd, { worktree: predecessor.cwd })

    const bySuccessor = await sup.park('worker-b')
    const byPredecessor = await sup.park('worker-a')

    expect(bySuccessor).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^worker-a \(not retired\)/),
    })
    expect(byPredecessor).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^worker-b \(not retired\)/),
    })
    expect(fs.existsSync(predecessor.cwd)).toBe(true)
  })

  it('refuses a tree it adopted even once its owner is gone, since resume could not re-create it', async () => {
    const repo = makeRepo()
    const assigned = path.join(repo, '.worktrees', 'task')
    git(['worktree', 'add', '-q', '-b', 'task', assigned], repo)
    await finishedIn('worker-a', repo, { worktree: assigned })

    const parked = await sup.park('worker-a')

    expect(parked).toMatchObject({ ok: false, reason: expect.stringMatching(/was adopted by worker-a/) })
    expect(fs.existsSync(assigned)).toBe(true)
  })
})

describe('refusing to park what the removal would lose', () => {
  it('refuses a commit on a detached HEAD in a repository with no remote', async () => {
    const repo = makeRepo()
    const agent = await spawnIn('worker-a', repo)
    git(['checkout', '-q', '--detach'], agent.cwd)
    const orphan = commitIn(agent.cwd, 'feature.ts')
    await exit(agent)

    const parked = await sup.park('worker-a')

    expect(parked).toMatchObject({ ok: false, reason: expect.stringMatching(/HEAD in .* is detached/) })
    expect(git(['rev-parse', 'HEAD'], agent.cwd)).toBe(orphan)
  })

  it('refuses a tree checked out on a different branch', async () => {
    const agent = await spawnIn('worker-a', makeRepo())
    git(['checkout', '-q', '-b', 'side'], agent.cwd)
    await exit(agent)

    const parked = await sup.park('worker-a')

    expect(parked).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/is on side, not on agent-chat\/worker-a/),
    })
    expect(fs.existsSync(agent.cwd)).toBe(true)
  })

  it('refuses an untracked file that status.showUntrackedFiles=no hides', async () => {
    const agent = await spawnIn('worker-a', makeRepo())
    git(['config', 'status.showUntrackedFiles', 'no'], agent.cwd)
    fs.writeFileSync(path.join(agent.cwd, 'notes.txt'), 'draft\n')
    await exit(agent)

    const parked = await sup.park('worker-a')

    expect(parked).toMatchObject({ ok: false, reason: expect.stringMatching(/untracked changes/) })
    expect(fs.existsSync(path.join(agent.cwd, 'notes.txt'))).toBe(true)
  })

  it('refuses an ignored file outside the regenerable set, naming the rule', async () => {
    const agent = await spawnIn('worker-a', makeRepo())
    fs.writeFileSync(path.join(agent.cwd, '.gitignore'), '.env\nnode_modules/\n')
    git(['add', '.gitignore'], agent.cwd)
    git(['commit', '-q', '-m', 'ignore'], agent.cwd)
    fs.writeFileSync(path.join(agent.cwd, '.env'), 'TOKEN=synthetic\n')
    await exit(agent)

    const parked = await sup.park('worker-a')

    expect(parked).toMatchObject({
      ok: false,
      reason: expect.stringMatching(
        /ignored files .* \(\.env\); park removes only ignored node_modules, dist/,
      ),
    })
    expect(fs.existsSync(path.join(agent.cwd, '.env'))).toBe(true)
  })

  it('parks a tree whose only ignored files are tsbuildinfo at the root and in a package dir', async () => {
    const agent = await spawnIn('worker-a', makeRepo())
    fs.writeFileSync(path.join(agent.cwd, '.gitignore'), '*.tsbuildinfo\n')
    git(['add', '.gitignore'], agent.cwd)
    git(['commit', '-q', '-m', 'ignore'], agent.cwd)
    fs.mkdirSync(path.join(agent.cwd, 'packages', 'core'), { recursive: true })
    fs.writeFileSync(path.join(agent.cwd, 'tsconfig.tsbuildinfo'), '{}\n')
    fs.writeFileSync(path.join(agent.cwd, 'packages', 'core', 'tsconfig.test.tsbuildinfo'), '{}\n')
    await exit(agent)

    expect((await sup.park('worker-a')).ok).toBe(true)
    expect(fs.existsSync(agent.cwd)).toBe(false)
  })

  it('refuses an ignored scratch file beside tsbuildinfo, naming only the scratch file', async () => {
    const agent = await spawnIn('worker-a', makeRepo())
    fs.writeFileSync(path.join(agent.cwd, '.gitignore'), '*.tsbuildinfo\nscratch.md\n')
    git(['add', '.gitignore'], agent.cwd)
    git(['commit', '-q', '-m', 'ignore'], agent.cwd)
    fs.writeFileSync(path.join(agent.cwd, 'tsconfig.tsbuildinfo'), '{}\n')
    fs.writeFileSync(path.join(agent.cwd, 'scratch.md'), 'notes\n')
    await exit(agent)

    const parked = await sup.park('worker-a')

    expect(parked).toMatchObject({ ok: false, reason: expect.stringMatching(/\(scratch\.md\)/) })
    expect(fs.existsSync(path.join(agent.cwd, 'scratch.md'))).toBe(true)
  })

  it('parks a tree whose only ignored files are regenerable', async () => {
    const agent = await spawnIn('worker-a', makeRepo())
    fs.writeFileSync(path.join(agent.cwd, '.gitignore'), 'node_modules/\ndist/\n')
    git(['add', '.gitignore'], agent.cwd)
    git(['commit', '-q', '-m', 'ignore'], agent.cwd)
    fs.mkdirSync(path.join(agent.cwd, 'node_modules', 'dep'), { recursive: true })
    fs.writeFileSync(path.join(agent.cwd, 'node_modules', 'dep', 'index.js'), '\n')
    fs.mkdirSync(path.join(agent.cwd, 'dist'))
    fs.writeFileSync(path.join(agent.cwd, 'dist', 'cli.js'), '\n')
    await exit(agent)

    expect((await sup.park('worker-a')).ok).toBe(true)
    expect(fs.existsSync(agent.cwd)).toBe(false)
  })
})

describe('refusing to park a running or shared agent', () => {
  it('refuses a detached agent whose process this broker still tracks', async () => {
    const agent = await spawnIn('worker-a', makeRepo())
    core.append({ kind: 'agent_detached', actor: 'worker-a', ref: agent.agentId, body: 'connection closed' })

    const parked = await sup.park('worker-a')

    expect(parked).toMatchObject({ ok: false, reason: expect.stringMatching(/worker-a is detached/) })
    expect(fs.existsSync(agent.cwd)).toBe(true)
  })

  it('parks a detached agent this broker no longer tracks, as after a broker restart', async () => {
    const agent = await spawnIn('worker-a', repoWithOrigin())
    core.append({ kind: 'agent_detached', actor: 'worker-a', ref: agent.agentId, body: 'connection closed' })
    ;(sup as unknown as { live: Map<string, unknown> }).live.delete(agent.agentId)
    git(['push', '-q', 'origin', git(['branch', '--show-current'], agent.cwd)], agent.cwd)

    const parked = await sup.park('worker-a')

    expect(parked.ok).toBe(true)
    expect(fs.existsSync(agent.cwd)).toBe(false)
  })

  it('refuses an exited agent whose process this broker still tracks', async () => {
    const agent = await spawnIn('worker-a', makeRepo())
    core.append({ kind: 'agent_exited', actor: 'worker-a', ref: agent.agentId, body: '' })

    const parked = await sup.park('worker-a')

    expect(parked).toMatchObject({ ok: false, reason: expect.stringMatching(/still tracked as running/) })
    expect(fs.existsSync(agent.cwd)).toBe(true)
  })

  it('lets a worker park only agents it spawned', async () => {
    const repo = makeRepo()
    const agent = await finishedIn('worker-a', repo)
    const worker = await spawnIn('worker-b', repo, { isolation: 'none', cwd: tmp('park-ws-') })

    const parked = await sup.park('worker-a', { requestedBy: 'worker-b', requesterAgentId: worker.agentId })

    expect(parked).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/can park only agents it spawned/),
    })
    expect(fs.existsSync(agent.cwd)).toBe(true)
  })

  it('refuses a resume that arrives while the park is in flight, and resume works once it finishes', async () => {
    const agent = await finishedIn('worker-a', makeRepo())

    const parking = sup.park('worker-a')
    const during = await sup.resume('worker-a')
    const parked = await parking

    expect(during).toMatchObject({ ok: false, reason: expect.stringMatching(/is being parked/) })
    expect(parked.ok).toBe(true)
    expect((await sup.resume('worker-a')).ok).toBe(true)
    expect(fs.existsSync(agent.cwd)).toBe(true)
  })

  it('refuses a spawn that adopts the tree while the park is in flight', async () => {
    const agent = await finishedIn('worker-a', makeRepo())

    const parking = sup.park('worker-a')
    const during = await sup.spawn(spawnReq('worker-b', agent.cwd, { worktree: agent.cwd }))
    await parking

    expect(during).toMatchObject({ ok: false, reason: expect.stringMatching(/is being parked/) })
  })
})
