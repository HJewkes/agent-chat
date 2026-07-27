import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  fileOwnershipStrategy,
  getStrategy,
  isWarning,
  noneStrategy,
  refusalsIn,
  resolve,
  toolsetStrategy,
} from '../agents/isolation/index.js'
import { matchPattern } from '../agents/isolation/file-ownership.js'
import {
  createWorktreeStrategy,
  findGitRoot,
  RECLAIM_GRACE_MS,
  WorktreeBudgetExhaustedError,
  WorktreeInUseError,
  worktreeStrategy,
} from '../agents/isolation/worktree.js'
import type { Allocation, IsolationContext, LivePeer } from '../agents/isolation/index.js'

const tmpdirs: string[] = []

afterEach(() => {
  while (tmpdirs.length > 0) {
    const dir = tmpdirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

/** A real repository with one commit — worktree behaviour is not provable against a mock. */
function makeRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'iso-')))
  tmpdirs.push(dir)
  git(['init', '-b', 'main'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  git(['config', 'user.name', 'Test'], dir)
  git(['config', 'commit.gpgsign', 'false'], dir)
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n')
  git(['add', '.'], dir)
  git(['commit', '-m', 'seed'], dir)
  return dir
}

const ctxFor = (cwd: string, overrides: Partial<IsolationContext> = {}): IsolationContext => ({
  agentId: 'ag-1',
  agentName: 'alice',
  baseCwd: cwd,
  ...overrides,
})

const commitIn = (dir: string, file: string): string => {
  fs.writeFileSync(path.join(dir, file), 'work\n')
  git(['add', file], dir)
  git(['commit', '-m', `add ${file}`], dir)
  return git(['rev-parse', 'HEAD'], dir)
}

const peer = (name: string, cwd: string, claims?: string[]): LivePeer => ({
  agentId: `ag-${name}`,
  name,
  cwd,
  ...(claims ? { claims } : {}),
})

describe('none', () => {
  it('warns about agents already in the same checkout without refusing', async () => {
    const ctx = ctxFor('/repo', { peers: [peer('bob', '/repo')] })
    const reasons = await noneStrategy.check(ctx)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('bob')
    expect(refusalsIn(reasons)).toEqual([])
  })

  it('says nothing about agents in other checkouts', async () => {
    expect(await noneStrategy.check(ctxFor('/repo', { peers: [peer('bob', '/elsewhere')] }))).toEqual([])
  })

  it('leaves the agent in the shared checkout and releases cleanly', async () => {
    const alloc = await noneStrategy.allocate(ctxFor('/repo'))
    expect(alloc).toEqual({ cwd: '/repo' })
    expect(await noneStrategy.release(ctxFor('/repo'), alloc)).toBe(true)
  })
})

describe('toolset-limited', () => {
  it('carries the profile tool lists into the allocation', async () => {
    const ctx = ctxFor('/repo', { toolset: { allowedTools: ['Read', 'Grep'], disallowedTools: ['Bash'] } })
    const alloc = await toolsetStrategy.allocate(ctx)
    expect(alloc.cwd).toBe('/repo')
    expect(alloc.allowedTools).toEqual(['Read', 'Grep'])
    expect(alloc.disallowedTools).toEqual(['Bash'])
    expect(alloc.note).toContain('Read, Grep')
  })

  it('warns when it would restrict nothing', async () => {
    const reasons = await toolsetStrategy.check(ctxFor('/repo'))
    expect(reasons.every(isWarning)).toBe(true)
    expect(reasons).toHaveLength(1)
  })
})

describe('file-ownership patterns', () => {
  it('matches directory prefixes, single-segment and multi-segment globs', () => {
    expect(matchPattern('src/cli/agent.ts', 'src/cli/')).toBe(true)
    expect(matchPattern('src/cli', 'src/cli/')).toBe(true)
    expect(matchPattern('src/server/x.ts', 'src/cli/')).toBe(false)
    expect(matchPattern('src/cli/agent.ts', 'src/*/agent.ts')).toBe(true)
    expect(matchPattern('src/a/b/agent.ts', 'src/*/agent.ts')).toBe(false)
    expect(matchPattern('src/a/b/agent.ts', 'src/**/agent.ts')).toBe(true)
    expect(matchPattern('package.json', 'package.json')).toBe(true)
    expect(matchPattern('src/agents/isolation/x.ts', 'src/agents/**')).toBe(true)
    expect(matchPattern('src/server/x.ts', 'src/agents/**')).toBe(false)
  })
})

describe('file-ownership strategy', () => {
  const claimant = ctxFor('/repo', {
    declaredPaths: ['src/agents/isolation/x.ts'],
    peers: [peer('bob', '/repo', ['src/agents/isolation/**'])],
  })

  it('warns by default when a claim overlaps a live peer', async () => {
    const reasons = await fileOwnershipStrategy.check(claimant)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('bob')
    expect(refusalsIn(reasons)).toEqual([])
  })

  it('refuses the same overlap under strict', async () => {
    const reasons = await fileOwnershipStrategy.check({ ...claimant, strict: true })
    expect(refusalsIn(reasons)).toHaveLength(1)
  })

  it('treats a claim as a lease on presence: a disconnected peer blocks nothing', async () => {
    const ctx = ctxFor('/repo', { declaredPaths: ['src/agents/isolation/x.ts'], peers: [], strict: true })
    expect(await fileOwnershipStrategy.check(ctx)).toEqual([])
  })

  it('ignores claims from peers working in another checkout', async () => {
    const ctx = { ...claimant, peers: [peer('bob', '/other', ['src/agents/isolation/**'])], strict: true }
    expect(await fileOwnershipStrategy.check(ctx)).toEqual([])
  })

  it('puts the ownership brief in the allocation without moving the agent', async () => {
    const alloc = await fileOwnershipStrategy.allocate(claimant)
    expect(alloc.cwd).toBe('/repo')
    expect(alloc.note).toContain('src/agents/isolation/x.ts')
    expect(alloc.note).toContain('Read-only')
    expect(await fileOwnershipStrategy.release(claimant, alloc)).toBe(true)
  })
})

describe('worktree allocate', () => {
  it('puts the agent on its own branch in its own directory', async () => {
    const repo = makeRepo()
    const alloc = await worktreeStrategy.allocate(ctxFor(repo))

    expect(alloc.cwd).toBe(path.join(repo, '.worktrees', 'alice'))
    expect(fs.existsSync(alloc.cwd)).toBe(true)
    expect(alloc.ref?.branch).toBe('agent-chat/alice')
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], alloc.cwd)).toBe('agent-chat/alice')
    expect(alloc.note).toContain('agent-chat/alice')
  })

  it('copies .claude/ in so hooks still fire inside the worktree', async () => {
    const repo = makeRepo()
    fs.mkdirSync(path.join(repo, '.claude'))
    fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), '{}')

    const alloc = await worktreeStrategy.allocate(ctxFor(repo))
    expect(fs.existsSync(path.join(alloc.cwd, '.claude', 'settings.json'))).toBe(true)
  })

  it('allocates against the main repo when called from inside a worktree', async () => {
    const repo = makeRepo()
    const first = await worktreeStrategy.allocate(ctxFor(repo))

    const nested = await worktreeStrategy.allocate(ctxFor(first.cwd, { agentName: 'bob', agentId: 'ag-2' }))
    expect(await findGitRoot(first.cwd)).toBe(repo)
    expect(nested.cwd).toBe(path.join(repo, '.worktrees', 'bob'))
  })

  it('cannot be escaped by a hostile agent name', async () => {
    const repo = makeRepo()
    const alloc = await worktreeStrategy.allocate(ctxFor(repo, { agentName: '../../etc/pwned' }))
    expect(alloc.cwd.startsWith(path.join(repo, '.worktrees'))).toBe(true)
  })

  it('refuses outside a git repository', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'iso-bare-')))
    tmpdirs.push(dir)
    const reasons = await worktreeStrategy.check(ctxFor(dir))
    expect(refusalsIn(reasons)[0]).toContain('not a git repository')
    await expect(worktreeStrategy.allocate(ctxFor(dir))).rejects.toThrow('not a git repository')
  })
})

describe('worktree budget', () => {
  it('reports exhaustion from check and throws from allocate', async () => {
    const repo = makeRepo()
    const strategy = createWorktreeStrategy({ budget: 1 })
    await strategy.allocate(ctxFor(repo))

    const ctx = ctxFor(repo, { agentName: 'bob', agentId: 'ag-2' })
    expect(refusalsIn(await strategy.check(ctx))[0]).toContain('budget exhausted')
    await expect(strategy.allocate(ctx)).rejects.toBeInstanceOf(WorktreeBudgetExhaustedError)
  })

  it('reclaims budget from a worktree whose directory vanished', async () => {
    const repo = makeRepo()
    const strategy = createWorktreeStrategy({ budget: 1 })
    const alloc = await strategy.allocate(ctxFor(repo))
    fs.rmSync(alloc.cwd, { recursive: true, force: true })

    const ctx = ctxFor(repo, { agentName: 'bob', agentId: 'ag-2' })
    expect(refusalsIn(await strategy.check(ctx))).toEqual([])
    await expect(strategy.allocate(ctx)).resolves.toBeDefined()
  })
})

describe('worktree re-allocation after a crash', () => {
  /** The crash path: work committed, the process died, release was never called. */
  const crashLeavingCommit = async (repo: string, ctx: IsolationContext): Promise<string> => {
    const alloc = await worktreeStrategy.allocate(ctx)
    const sha = commitIn(alloc.cwd, 'work.ts')
    fs.rmSync(alloc.cwd, { recursive: true, force: true })
    return sha
  }

  it('adopts the branch a crashed agent left behind rather than deleting its commits', async () => {
    const repo = makeRepo()
    const ctx = ctxFor(repo, { agentName: 'scout' })
    const sha = await crashLeavingCommit(repo, ctx)

    const second = await worktreeStrategy.allocate(ctx)
    expect(git(['rev-parse', 'agent-chat/scout'], repo)).toBe(sha)
    expect(git(['rev-parse', 'HEAD'], second.cwd)).toBe(sha)
    expect(second.ref?.reused).toBe('true')
  })

  it('discards that branch only when the caller asks for it', async () => {
    const repo = makeRepo()
    const ctx = ctxFor(repo, { agentName: 'scout' })
    const sha = await crashLeavingCommit(repo, ctx)

    const second = await worktreeStrategy.allocate({ ...ctx, forceReset: true })
    expect(git(['rev-parse', 'HEAD'], second.cwd)).toBe(git(['rev-parse', 'main'], repo))
    expect(git(['rev-parse', 'HEAD'], second.cwd)).not.toBe(sha)
  })

  it('resets a leftover branch that holds nothing, so the agent starts from current HEAD', async () => {
    const repo = makeRepo()
    git(['branch', 'agent-chat/alice'], repo)
    const moved = commitIn(repo, 'later.ts')

    const alloc = await worktreeStrategy.allocate(ctxFor(repo))
    expect(git(['rev-parse', 'HEAD'], alloc.cwd)).toBe(moved)
    expect(alloc.ref?.reused).toBeUndefined()
  })

  it('refuses rather than clobbering a worktree that is still on disk', async () => {
    const repo = makeRepo()
    const ctx = ctxFor(repo, { agentName: 'scout' })
    const first = await worktreeStrategy.allocate(ctx)
    fs.writeFileSync(path.join(first.cwd, 'scratch.ts'), 'half-finished\n')

    await expect(worktreeStrategy.allocate(ctx)).rejects.toBeInstanceOf(WorktreeInUseError)
    expect(fs.readFileSync(path.join(first.cwd, 'scratch.ts'), 'utf8')).toBe('half-finished\n')
  })

  it('clobbers that worktree when forced, like release does', async () => {
    const repo = makeRepo()
    const ctx = ctxFor(repo, { agentName: 'scout' })
    const first = await worktreeStrategy.allocate(ctx)
    fs.writeFileSync(path.join(first.cwd, 'scratch.ts'), 'half-finished\n')

    const second = await worktreeStrategy.allocate({ ...ctx, forceReset: true })
    expect(second.cwd).toBe(first.cwd)
    expect(fs.existsSync(path.join(second.cwd, 'scratch.ts'))).toBe(false)
  })
})

describe('worktree release', () => {
  it('removes the worktree and branch when nothing would be lost', async () => {
    const repo = makeRepo()
    const ctx = ctxFor(repo)
    const alloc = await worktreeStrategy.allocate(ctx)

    expect(await worktreeStrategy.release(ctx, alloc)).toBe(true)
    expect(fs.existsSync(alloc.cwd)).toBe(false)
    expect(git(['branch', '--list', 'agent-chat/alice'], repo)).toBe('')
  })

  it('refuses while the worktree has uncommitted work, and leaves it on disk', async () => {
    const repo = makeRepo()
    const ctx = ctxFor(repo)
    const alloc = await worktreeStrategy.allocate(ctx)
    fs.writeFileSync(path.join(alloc.cwd, 'scratch.ts'), 'half-finished\n')

    expect(await worktreeStrategy.release(ctx, alloc)).toBe(false)
    expect(fs.readFileSync(path.join(alloc.cwd, 'scratch.ts'), 'utf8')).toBe('half-finished\n')
  })

  it('refuses while commits exist nowhere but this branch', async () => {
    const repo = makeRepo()
    const ctx = ctxFor(repo)
    const alloc = await worktreeStrategy.allocate(ctx)
    commitIn(alloc.cwd, 'feature.ts')

    expect(await worktreeStrategy.release(ctx, alloc)).toBe(false)
    expect(git(['branch', '--list', 'agent-chat/alice'], repo)).toContain('agent-chat/alice')
  })

  it('releases once those commits are also on the remote', async () => {
    const repo = makeRepo()
    const remote = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'iso-remote-')))
    tmpdirs.push(remote)
    git(['init', '--bare', '-b', 'main'], remote)
    git(['remote', 'add', 'origin', remote], repo)

    const ctx = ctxFor(repo)
    const alloc = await worktreeStrategy.allocate(ctx)
    commitIn(alloc.cwd, 'feature.ts')
    git(['push', 'origin', 'agent-chat/alice'], alloc.cwd)

    expect(await worktreeStrategy.release(ctx, alloc)).toBe(true)
  })

  it('destroys unpushed work only when forced', async () => {
    const repo = makeRepo()
    const ctx = ctxFor(repo)
    const alloc = await worktreeStrategy.allocate(ctx)
    commitIn(alloc.cwd, 'feature.ts')

    expect(await worktreeStrategy.release(ctx, alloc, { force: true })).toBe(true)
    expect(fs.existsSync(alloc.cwd)).toBe(false)
    expect(git(['branch', '--list', 'agent-chat/alice'], repo)).toBe('')
  })

  it('holds a just-exited agent inside the grace window even when clean', async () => {
    const repo = makeRepo()
    const alloc = await worktreeStrategy.allocate(ctxFor(repo))

    const justExited = ctxFor(repo, { exitedAt: Date.now() })
    expect(await worktreeStrategy.release(justExited, alloc)).toBe(false)
    expect(fs.existsSync(alloc.cwd)).toBe(true)

    const longExited = ctxFor(repo, { exitedAt: Date.now() - RECLAIM_GRACE_MS - 1000 })
    expect(await worktreeStrategy.release(longExited, alloc)).toBe(true)
  })

  it('reports refusal rather than success for an allocation it does not recognise', async () => {
    const repo = makeRepo()
    const alien: Allocation = { cwd: repo }
    expect(await worktreeStrategy.release(ctxFor(repo), alien)).toBe(false)
  })
})

describe('registry and composition', () => {
  it('resolves each name to its own strategy', () => {
    expect(getStrategy('none').name).toBe('none')
    expect(getStrategy('worktree').name).toBe('worktree')
    expect(getStrategy('file-ownership').name).toBe('file-ownership')
    expect(getStrategy('toolset-limited').name).toBe('toolset-limited')
    expect(resolve(['worktree'])).toBe(worktreeStrategy)
    expect(resolve([]).name).toBe('none')
  })

  it('layers a toolset over a worktree: narrowed tools, worktree cwd', async () => {
    const repo = makeRepo()
    const ctx = ctxFor(repo, { toolset: { allowedTools: ['Read', 'Edit'] } })
    const composed = resolve(['toolset-limited', 'worktree'])

    const alloc = await composed.allocate(ctx)
    expect(alloc.cwd).toBe(path.join(repo, '.worktrees', 'alice'))
    expect(alloc.allowedTools).toEqual(['Read', 'Edit'])
    expect(alloc.note).toContain('Read, Edit')
    expect(alloc.note).toContain('agent-chat/alice')

    expect(await composed.release(ctx, alloc)).toBe(true)
    expect(fs.existsSync(alloc.cwd)).toBe(false)
  })

  it('propagates a member strategy refusing to release', async () => {
    const repo = makeRepo()
    const ctx = ctxFor(repo)
    const composed = resolve(['toolset-limited', 'worktree'])
    const alloc = await composed.allocate(ctx)
    fs.writeFileSync(path.join(alloc.cwd, 'scratch.ts'), 'half-finished\n')

    expect(await composed.release(ctx, alloc)).toBe(false)
    expect(fs.existsSync(alloc.cwd)).toBe(true)
  })

  it('gathers check output from every member', async () => {
    const composed = resolve(['none', 'toolset-limited'])
    const reasons = await composed.check(ctxFor('/repo', { peers: [peer('bob', '/repo')] }))
    expect(reasons).toHaveLength(2)
    expect(reasons.every(isWarning)).toBe(true)
  })
})
