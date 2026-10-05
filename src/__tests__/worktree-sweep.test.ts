import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { reclaim, sweepWorktrees, type GitLister } from '../agents/isolation/sweep.js'
import { RECLAIM_GRACE_MS, worktreeStrategy } from '../agents/isolation/worktree.js'
import { writeRuntimeState, readRuntimeState } from '../agents/launch-files.js'
import type { AgentIdentity } from '../protocol.js'

/**
 * CC-80. Retire releases a worktree when a person decides they are done. The
 * leak is the case where nobody decides — an agent exits, is never retired, and
 * holds its worktree and branch indefinitely. These prove the sweep finds that,
 * and that every guard which stops it destroying work still stands.
 */

const tmpDirs: string[] = []

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

const lister: GitLister = async gitRoot => git(['worktree', 'list', '--porcelain'], gitRoot)

function makeRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-')))
  tmpDirs.push(dir)
  git(['init', '-b', 'main'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  git(['config', 'user.name', 'Test'], dir)
  git(['config', 'commit.gpgsign', 'false'], dir)
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n')
  git(['add', '.'], dir)
  git(['commit', '-m', 'seed'], dir)
  return dir
}

/** An agent that allocated a worktree and left its runtime state behind. */
async function abandonedWorktree(repo: string, name = 'scout', agentId = 'a1'): Promise<string> {
  const allocation = await worktreeStrategy.allocate({ agentId, agentName: name, baseCwd: repo })
  writeRuntimeState(agentId, { handle: { surface: 'headless' }, allocation, isolation: 'worktree' })
  return allocation.cwd
}

const identity = (over: Partial<AgentIdentity> = {}): AgentIdentity =>
  ({
    agentId: 'a1',
    name: 'scout',
    profile: 'implementer',
    state: 'exited',
    origin: 'spawned',
    spawnedBy: 'human',
    spawnedAt: 0,
    brief: '',
    cwd: '',
    isolation: 'worktree',
    surface: 'headless',
    sessionId: '',
    lastEventAt: 0,
    generation: 1,
    ...over,
  }) as AgentIdentity

beforeEach(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-home-'))
  tmpDirs.push(home)
  process.env.AGENT_CHAT_HOME = home
})

afterEach(() => {
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('finding what nobody is using', () => {
  it('reports a worktree whose agent exited and was never retired', async () => {
    const repo = makeRepo()
    const worktree = await abandonedWorktree(repo)

    const swept = await sweepWorktrees([identity()], { list: lister, now: () => RECLAIM_GRACE_MS + 1 })

    expect(swept).toHaveLength(1)
    expect(swept[0]?.status).toBe('reclaimable')
    expect(swept[0]?.worktree).toBe(worktree)
    expect(swept[0]?.agent?.name).toBe('scout')
  })

  it('leaves a worktree alone while its agent is still running', async () => {
    const repo = makeRepo()
    await abandonedWorktree(repo)

    const swept = await sweepWorktrees([identity({ state: 'live' })], { list: lister })

    expect(swept[0]?.status).toBe('held')
    expect(swept[0]?.detail).toMatch(/scout is live/)
  })

  it('holds off inside the grace window that protects work nobody has noticed', async () => {
    const repo = makeRepo()
    await abandonedWorktree(repo)

    const swept = await sweepWorktrees([identity({ lastEventAt: 1000 })], {
      list: lister,
      now: () => 1000 + RECLAIM_GRACE_MS / 2,
    })

    expect(swept[0]?.status).toBe('in-grace')
    expect(swept[0]?.detail).toMatch(/reclaimable after 120s/)
  })

  it('times the grace window from the exit, not from a later row such as a refused retire', async () => {
    const repo = makeRepo()
    await abandonedWorktree(repo)
    const exitedAt = 1000
    const refusedRetireAt = exitedAt + 85_000

    const swept = await sweepWorktrees([identity({ exitedAt, lastEventAt: refusedRetireAt })], {
      list: lister,
      now: () => exitedAt + RECLAIM_GRACE_MS + 1,
    })

    expect(swept[0]?.status).toBe('reclaimable')
  })

  it('times the grace window from the detach for an agent that never exited', async () => {
    const repo = makeRepo()
    await abandonedWorktree(repo)
    const detachedAt = 1_000_000

    const swept = await sweepWorktrees(
      [identity({ state: 'detached', detachedAt, lastEventAt: detachedAt })],
      {
        list: lister,
        now: () => detachedAt + RECLAIM_GRACE_MS / 2,
      },
    )

    expect(swept[0]?.status).toBe('in-grace')
  })

  it('reclaims an agent with no exit time once its detach is old, whatever row came after', async () => {
    const repo = makeRepo()
    await abandonedWorktree(repo)
    const detachedAt = 1_000_000
    const refusedRetireAt = detachedAt + 100_000

    const swept = await sweepWorktrees(
      [identity({ state: 'detached', detachedAt, lastEventAt: refusedRetireAt })],
      { list: lister, now: () => detachedAt + RECLAIM_GRACE_MS + 1 },
    )

    expect(swept[0]?.status).toBe('reclaimable')
  })

  it('refuses one holding commits that exist nowhere else', async () => {
    const repo = makeRepo()
    const worktree = await abandonedWorktree(repo)
    fs.writeFileSync(path.join(worktree, 'feature.ts'), 'work\n')
    git(['add', 'feature.ts'], worktree)
    git(['commit', '-m', 'work'], worktree)

    const swept = await sweepWorktrees([identity()], { list: lister, now: () => RECLAIM_GRACE_MS + 1 })

    expect(swept[0]?.status).toBe('holds-work')
    expect(swept[0]?.detail).toMatch(/exist nowhere else/)
  })

  it('refuses one with uncommitted changes', async () => {
    const repo = makeRepo()
    const worktree = await abandonedWorktree(repo)
    fs.writeFileSync(path.join(worktree, 'scratch.txt'), 'unsaved\n')

    const swept = await sweepWorktrees([identity()], { list: lister, now: () => RECLAIM_GRACE_MS + 1 })

    expect(swept[0]?.status).toBe('holds-work')
    expect(swept[0]?.detail).toMatch(/uncommitted changes/)
  })

  /**
   * A worktree from before runtime state was persisted has nothing on disk
   * pointing at it, which is why the CLI passes the repo it was run in.
   */
  it('finds one no runtime state points at, when the repo is named', async () => {
    const repo = makeRepo()
    await worktreeStrategy.allocate({ agentId: 'gone', agentName: 'ghost', baseCwd: repo })

    const swept = await sweepWorktrees([], { list: lister, roots: [repo], now: () => RECLAIM_GRACE_MS + 1 })

    expect(swept[0]?.branch).toBe('agent-chat/ghost')
    expect(swept[0]?.agent).toBeUndefined()
    expect(swept[0]?.detail).toMatch(/no agent in the log claims this branch/)
  })

  /**
   * Claude Code's own agent worktrees sit on ordinary branch names and are
   * usually locked. They are a different tool's leak; reporting a reclaim here
   * that we would then refuse to perform would be worse than ignoring them.
   */
  it('ignores worktrees another tool owns, including locked ones', async () => {
    const repo = makeRepo()
    const foreign = path.join(repo, 'not-ours')
    git(['worktree', 'add', '-b', 'feat/somebody-elses', foreign], repo)
    git(['worktree', 'lock', foreign], repo)

    expect(await sweepWorktrees([], { list: lister, roots: [repo] })).toEqual([])
  })
})

/**
 * CC-277. Ownership was joined on the branch alone, so an agent working in a
 * tree under a different name (an adopting successor, an isolation-none
 * reviewer) was invisible and its checkout looked reclaimable.
 */
describe('a worktree someone is standing in', () => {
  const now = () => RECLAIM_GRACE_MS + 1

  it.each([
    ['a successor spawned with worktree: on the predecessor tree', { isolation: 'worktree' }],
    ['an isolation-none reviewer whose cwd is the tree', { isolation: 'none' }],
  ])('is held for %s, and prune leaves it', async (_label, over) => {
    const repo = makeRepo()
    const worktree = await abandonedWorktree(repo)
    const occupant = identity({
      agentId: 'a2',
      name: 'reviewer',
      state: 'live',
      cwd: worktree,
      ...over,
    })

    const swept = await sweepWorktrees([identity(), occupant], { list: lister, now })

    expect(swept[0]?.status).toBe('held')
    expect(swept[0]?.detail).toMatch(/reviewer is live/)
    expect((await reclaim(swept[0] as never)).ok).toBe(false)
    expect(fs.existsSync(worktree)).toBe(true)
  })

  it('matches through a symlinked path to the same directory', async () => {
    const repo = makeRepo()
    const worktree = await abandonedWorktree(repo)
    const link = path.join(os.tmpdir(), `sweep-link-${process.pid}`)
    fs.symlinkSync(worktree, link)
    tmpDirs.push(link)

    const swept = await sweepWorktrees(
      [identity(), identity({ agentId: 'a2', name: 'reviewer', state: 'spawning', cwd: link })],
      {
        list: lister,
        now,
      },
    )

    expect(swept[0]?.status).toBe('held')
  })

  it('is held for an agent whose cwd is a subdirectory of the tree', async () => {
    const repo = makeRepo()
    const worktree = await abandonedWorktree(repo)
    const sub = path.join(worktree, 'packages', 'app')
    fs.mkdirSync(sub, { recursive: true })

    const swept = await sweepWorktrees(
      [identity(), identity({ agentId: 'a2', name: 'reviewer', state: 'live', cwd: sub })],
      {
        list: lister,
        now,
      },
    )

    expect(swept[0]?.status).toBe('held')
  })

  it('is not held for an agent in a sibling path that shares the tree name as a prefix', async () => {
    const repo = makeRepo()
    const worktree = await abandonedWorktree(repo)
    const sibling = `${worktree}b`
    fs.mkdirSync(sibling)
    tmpDirs.push(sibling)

    const swept = await sweepWorktrees(
      [identity(), identity({ agentId: 'a2', name: 'reviewer', state: 'live', cwd: sibling })],
      {
        list: lister,
        now,
      },
    )

    expect(swept[0]?.status).toBe('reclaimable')
  })

  it('neither throws nor holds for an agent whose cwd no longer exists', async () => {
    const repo = makeRepo()
    const worktree = await abandonedWorktree(repo)
    const vanished = path.join(os.tmpdir(), `sweep-vanished-${process.pid}`, 'gone')

    const swept = await sweepWorktrees(
      [identity(), identity({ agentId: 'a2', name: 'reviewer', state: 'live', cwd: vanished })],
      {
        list: lister,
        now,
      },
    )

    expect(swept[0]?.status).toBe('reclaimable')
    expect(swept[0]?.worktree).toBe(worktree)
  })

  it('does not hold a tree for a detached agent, which counts as finished', async () => {
    const repo = makeRepo()
    const worktree = await abandonedWorktree(repo)

    const swept = await sweepWorktrees(
      [
        identity(),
        identity({
          agentId: 'a2',
          name: 'reviewer',
          state: 'detached',
          cwd: worktree,
          lastEventAt: now() - 1,
        }),
      ],
      {
        list: lister,
        now,
      },
    )

    expect(swept[0]?.status).toBe('reclaimable')
  })

  it('does not hold a tree for an agent that has exited', async () => {
    const repo = makeRepo()
    const worktree = await abandonedWorktree(repo)

    const swept = await sweepWorktrees(
      [identity(), identity({ agentId: 'a2', name: 'reviewer', cwd: worktree, lastEventAt: now() - 1 })],
      {
        list: lister,
        now,
      },
    )

    expect(swept[0]?.status).toBe('reclaimable')
  })
})

describe('reclaiming', () => {
  it('removes the worktree, deletes the branch, and forgets the allocation', async () => {
    const repo = makeRepo()
    const worktree = await abandonedWorktree(repo)
    const [entry] = await sweepWorktrees([identity()], { list: lister, now: () => RECLAIM_GRACE_MS + 1 })

    expect((await reclaim(entry as never)).ok).toBe(true)

    expect(fs.existsSync(worktree)).toBe(false)
    expect(git(['branch', '--list', 'agent-chat/scout'], repo)).toBe('')
    expect(readRuntimeState('a1')).toBeUndefined()
  })

  it('refuses anything the sweep did not call reclaimable', async () => {
    const repo = makeRepo()
    const worktree = await abandonedWorktree(repo)
    fs.writeFileSync(path.join(worktree, 'scratch.txt'), 'unsaved\n')
    const [entry] = await sweepWorktrees([identity()], { list: lister, now: () => RECLAIM_GRACE_MS + 1 })

    const result = await reclaim(entry as never)

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/holds-work/)
    expect(fs.existsSync(worktree)).toBe(true)
  })

  it('destroys it anyway when a human forces it', async () => {
    const repo = makeRepo()
    const worktree = await abandonedWorktree(repo)
    fs.writeFileSync(path.join(worktree, 'scratch.txt'), 'unsaved\n')
    const [entry] = await sweepWorktrees([identity()], { list: lister, now: () => RECLAIM_GRACE_MS + 1 })

    expect((await reclaim(entry as never, { force: true })).ok).toBe(true)
    expect(fs.existsSync(worktree)).toBe(false)
  })
})
