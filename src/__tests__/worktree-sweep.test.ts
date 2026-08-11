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
