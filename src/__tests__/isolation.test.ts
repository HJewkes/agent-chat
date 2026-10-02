import { execFile, execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  fileOwnershipStrategy,
  getStrategy,
  isWarning,
  noneStrategy,
  refusalOf,
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
import type { GitRunner } from '../agents/isolation/worktree.js'
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
    expect(alloc.note).toContain('Bash are unavailable')
  })

  it('warns when it would restrict nothing', async () => {
    const reasons = await toolsetStrategy.check(ctxFor('/repo'))
    expect(reasons.every(isWarning)).toBe(true)
    expect(reasons).toHaveLength(1)
  })

  // The regression that matters: an allow list alone confines nothing, because
  // the agent still inherits settings that may grant Bash. The old check went
  // quiet here, which is how a read-only profile kept a shell.
  it('still warns when an allow list is present but nothing is denied', async () => {
    const ctx = ctxFor('/repo', { toolset: { allowedTools: ['Read', 'Grep', 'Glob'] } })
    const reasons = await toolsetStrategy.check(ctx)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('disallowedTools')
  })

  it('goes quiet only once a deny list is actually present', async () => {
    const ctx = ctxFor('/repo', { toolset: { allowedTools: ['Read'], disallowedTools: ['Bash'] } })
    expect(await toolsetStrategy.check(ctx)).toEqual([])
  })

  /**
   * 2026-08-31: an explorer read "Your tools are limited to: Read, Grep, Glob",
   * concluded chat_send was not available to it, and ended its turn without one
   * tool call — while `launch-plan` had appended the agent-chat grant to its argv
   * all along. An agent that believes it cannot report back does not report back,
   * which is the whole cost of spawning it.
   */
  it('tells the agent it can still chat, which the profile list alone does not say', async () => {
    const ctx = ctxFor('/repo', {
      toolset: { allowedTools: ['Read', 'Grep', 'Glob'], disallowedTools: ['Bash'] },
    })
    const alloc = await toolsetStrategy.allocate(ctx)

    expect(alloc.note).toContain('chat_send')
    expect(alloc.note).toContain('ToolSearch')
    // The three claims the agent made, each contradicted by the note it is given.
    expect(alloc.note).not.toMatch(/limited to: Read, Grep, Glob\.?$/)
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

  it('does not see a declared glob that swallows a live concrete claim (CC-92)', async () => {
    // The asymmetry is the point: a declared FILE under a peer's glob is caught
    // above, the reverse is not, and that holds only while the manifest is
    // coordinator-issued. Adopting patternsOverlap here would close it, and
    // should be a decision rather than a side effect.
    const ctx = ctxFor('/repo', {
      declaredPaths: ['src/agents/**'],
      peers: [peer('bob', '/repo', ['src/agents/isolation/x.ts'])],
      strict: true,
    })
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

  describe('a branch that commits .claude as a symlink (CC-459)', () => {
    /** The branch is committed first so adoption checks it out with the link in place. */
    function repoWithBranchSymlink(linkTarget: string): string {
      const repo = makeRepo()
      git(['checkout', '-b', 'agent-chat/alice'], repo)
      fs.symlinkSync(linkTarget, path.join(repo, '.claude'))
      git(['add', '.claude'], repo)
      git(['commit', '-m', 'commit .claude as a symlink'], repo)
      git(['checkout', 'main'], repo)
      fs.mkdirSync(path.join(repo, '.claude'))
      fs.writeFileSync(path.join(repo, '.claude', 'settings.json'), '{}')
      return repo
    }

    it('survives a dangling symlink and writes nothing through it', async () => {
      const outside = path.join(os.tmpdir(), `iso-outside-${process.pid}-dangling`)
      tmpdirs.push(outside)
      const repo = repoWithBranchSymlink(outside)

      const alloc = await worktreeStrategy.allocate(ctxFor(repo))

      expect(fs.lstatSync(path.join(alloc.cwd, '.claude')).isSymbolicLink()).toBe(true)
      expect(fs.existsSync(outside)).toBe(false)
    })

    it('does not copy settings into a real directory outside the tree', async () => {
      const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'iso-outside-')))
      tmpdirs.push(outside)
      const repo = repoWithBranchSymlink(outside)

      await worktreeStrategy.allocate(ctxFor(repo))

      expect(fs.readdirSync(outside)).toEqual([])
    })
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

  it('reads the budget from config.json on every spawn when none is passed in', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-budget-'))
    tmpdirs.push(home)
    process.env.AGENT_CHAT_HOME = home
    try {
      const repo = makeRepo()
      const strategy = createWorktreeStrategy()
      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ worktreeBudget: 1 }))
      await strategy.allocate(ctxFor(repo))
      const second = ctxFor(repo, { agentName: 'bob', agentId: 'ag-2' })
      await expect(strategy.allocate(second)).rejects.toBeInstanceOf(WorktreeBudgetExhaustedError)

      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ worktreeBudget: 2 }))

      await expect(strategy.allocate(second)).resolves.toBeDefined()
    } finally {
      delete process.env.AGENT_CHAT_HOME
    }
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

/** Hangs every fetch, then exits within 0.2s of the fetching git being killed so no child outlives the test. */
const HANG_UNTIL_GIT_DIES = `#!/bin/sh
git_pid=$(ps -o ppid= -p $PPID)
while kill -0 $git_pid 2>/dev/null; do sleep 0.2; done
`

describe('worktree branch base (CC-151)', () => {
  const tmp = (prefix: string): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
    tmpdirs.push(dir)
    return dir
  }

  /** A bare "origin", a peer clone that pushes to it, and the main checkout under test. */
  function clonedFromOrigin(defaultBranch = 'main'): { origin: string; peer: string; local: string } {
    const seed = makeRepo()
    if (defaultBranch !== 'main') git(['branch', '-m', 'main', defaultBranch], seed)
    const origin = path.join(tmp('iso-origin-'), 'origin.git')
    git(['clone', '--quiet', '--bare', seed, origin], seed)
    const clone = (): string => {
      const dir = path.join(tmp('iso-clone-'), 'repo')
      git(['clone', '--quiet', origin, dir], seed)
      git(['config', 'user.email', 'test@example.com'], dir)
      git(['config', 'user.name', 'Test'], dir)
      git(['config', 'commit.gpgsign', 'false'], dir)
      return dir
    }
    return { origin, peer: clone(), local: clone() }
  }

  it("cuts the branch at origin's tip when the local main is behind", async () => {
    const { peer, local } = clonedFromOrigin()
    const merged = commitIn(peer, 'merged.ts')
    git(['push', '--quiet', 'origin', 'main'], peer)

    const alloc = await worktreeStrategy.allocate(ctxFor(local))

    expect(git(['rev-parse', 'HEAD'], alloc.cwd)).toBe(merged)
    expect(alloc.ref).toMatchObject({ base: merged, base_ref: 'origin/main' })
    expect(alloc.warnings).toBeUndefined()
  })

  it("leaves out a commit sitting unpushed on the main checkout's HEAD", async () => {
    const { local } = clonedFromOrigin()
    const originTip = git(['rev-parse', 'HEAD'], local)
    const foreign = commitIn(local, 'someone-elses.ts')

    const alloc = await worktreeStrategy.allocate(ctxFor(local))

    expect(git(['rev-parse', 'HEAD'], alloc.cwd)).toBe(originTip)
    expect(git(['rev-list', `${foreign}..HEAD`], alloc.cwd)).toBe('')
    expect(fs.existsSync(path.join(alloc.cwd, 'someone-elses.ts'))).toBe(false)
  })

  it("never moves the main checkout's HEAD or touches its files", async () => {
    const { peer, local } = clonedFromOrigin()
    commitIn(peer, 'merged.ts')
    git(['push', '--quiet', 'origin', 'main'], peer)
    const headBefore = git(['rev-parse', 'HEAD'], local)
    fs.writeFileSync(path.join(local, 'README.md'), 'edited in the main checkout\n')

    await worktreeStrategy.allocate(ctxFor(local))

    expect(git(['rev-parse', 'HEAD'], local)).toBe(headBefore)
    expect(git(['status', '--porcelain', '--untracked-files=no'], local)).toBe('M README.md')
    expect(fs.readFileSync(path.join(local, 'README.md'), 'utf8')).toBe('edited in the main checkout\n')
  })

  it('falls back to master when origin/HEAD is unknown and there is no main', async () => {
    const { origin, peer } = clonedFromOrigin('master')
    const tip = commitIn(peer, 'merged.ts')
    git(['push', '--quiet', 'origin', 'master'], peer)
    const local = makeRepo()
    git(['remote', 'add', 'origin', origin], local)

    const alloc = await worktreeStrategy.allocate(ctxFor(local))

    expect(git(['rev-parse', 'HEAD'], alloc.cwd)).toBe(tip)
    expect(alloc.ref?.base_ref).toBe('origin/master')
  })

  it('uses the local HEAD and says so when the fetch fails', async () => {
    const { local } = clonedFromOrigin()
    git(['remote', 'set-url', 'origin', path.join(tmp('iso-gone-'), 'missing.git')], local)
    const localHead = commitIn(local, 'unpushed.ts')

    const alloc = await worktreeStrategy.allocate(ctxFor(local))

    expect(git(['rev-parse', 'HEAD'], alloc.cwd)).toBe(localHead)
    expect(alloc.ref).toMatchObject({ base: localHead, base_ref: 'HEAD' })
    expect(alloc.warnings).toEqual([expect.stringContaining(`local HEAD at ${localHead}`)])
    expect(alloc.warnings?.[0]).toContain('origin/main')
  })

  it("cuts every concurrent allocation from origin's tip, not just the fetch that won the ref lock", async () => {
    const { peer, local } = clonedFromOrigin()
    const merged = commitIn(peer, 'merged.ts')
    git(['push', '--quiet', 'origin', 'main'], peer)
    const strategy = createWorktreeStrategy({ budget: 10 })
    const names = ['w1', 'w2', 'w3', 'w4', 'w5']

    const allocs = await Promise.all(names.map(name => strategy.allocate(ctxFor(local, { agentName: name }))))

    expect(allocs.map(a => git(['rev-parse', 'HEAD'], a.cwd))).toEqual(names.map(() => merged))
    expect(allocs.flatMap(a => a.warnings ?? [])).toEqual([])
  })

  it('spends one timeout across every default-branch candidate, not one each', async () => {
    const local = makeRepo()
    const hang = path.join(tmp('iso-hang-'), 'hang.sh')
    fs.writeFileSync(hang, HANG_UNTIL_GIT_DIES, { mode: 0o755 })
    git(['config', 'protocol.ext.allow', 'always'], local)
    git(['remote', 'add', 'origin', `ext::${hang}`], local)
    const strategy = createWorktreeStrategy({ fetchTimeoutMs: 1_500 })

    const started = Date.now()
    const alloc = await strategy.allocate(ctxFor(local))

    expect(Date.now() - started).toBeLessThan(2_900)
    expect(alloc.warnings?.[0]).toContain('failed or timed out')
  })

  it('warns that there is no origin when the repository has none', async () => {
    const repo = makeRepo()

    const alloc = await worktreeStrategy.allocate(ctxFor(repo))

    expect(alloc.warnings?.[0]).toContain('no origin remote')
  })
})

describe('concurrent worktree adds (CC-224)', () => {
  const runGit = promisify(execFile)
  const realAdd: GitRunner = async (args, cwd) => (await runGit('git', [...args], { cwd })).stdout.trim()
  /** Finishes before boundedAdd arms its timer, so a slow runner cannot turn the add into a timeout. */
  const addBeforeTimer = (args: readonly string[], cwd: string): string => git([...args], cwd)

  /** Records when each add starts and ends; the delay widens any overlap so it cannot slip past. */
  function recordingAdd(): { run: GitRunner; spans: { start: number; end: number }[] } {
    const spans: { start: number; end: number }[] = []
    let clock = 0
    const run: GitRunner = async (args, cwd) => {
      const span = { start: clock++, end: -1 }
      spans.push(span)
      await new Promise(resolve => setTimeout(resolve, 20))
      try {
        return await realAdd(args, cwd)
      } finally {
        span.end = clock++
      }
    }
    return { run, spans }
  }

  it('never lets two allocations in one repository run their worktree add at once', async () => {
    const repo = makeRepo()
    const { run, spans } = recordingAdd()
    const strategy = createWorktreeStrategy({ budget: 10, runWorktreeAdd: run })
    const names = ['w1', 'w2', 'w3', 'w4', 'w5']

    const allocs = await Promise.all(names.map(name => strategy.allocate(ctxFor(repo, { agentName: name }))))

    expect(allocs).toHaveLength(names.length)
    expect(spans).toHaveLength(names.length)
    spans.forEach((span, i) => expect(span.start).toBe(i * 2))
    spans.forEach(span => expect(span.end).toBe(span.start + 1))
  })

  it('lets the next allocation in a repository proceed after an add fails', async () => {
    const repo = makeRepo()
    let calls = 0
    const failFirst: GitRunner = (args, cwd) =>
      calls++ === 0 ? Promise.reject(new Error('add failed')) : realAdd(args, cwd)
    const strategy = createWorktreeStrategy({ budget: 10, runWorktreeAdd: failFirst })

    const settled = await Promise.allSettled(
      ['w1', 'w2'].map(name => strategy.allocate(ctxFor(repo, { agentName: name }))),
    )

    // Either name may reach the add lock first, so only the outcome set is fixed.
    expect(settled.map(s => s.status).sort()).toEqual(['fulfilled', 'rejected'])
  })

  it('rejects an add that never resolves, naming the repo and timeout, and lets the next add run', async () => {
    const repo = makeRepo()
    let calls = 0
    const hangFirst: GitRunner = async (args, cwd) =>
      calls++ === 0 ? new Promise<string>(() => {}) : addBeforeTimer(args, cwd)
    const strategy = createWorktreeStrategy({ budget: 10, addTimeoutMs: 200, runWorktreeAdd: hangFirst })

    const first = strategy.allocate(ctxFor(repo, { agentName: 'w1' }))
    const second = strategy.allocate(ctxFor(repo, { agentName: 'w2' }))
    const settled = await Promise.allSettled([first, second])

    // Either name may reach the add lock first, so only the outcome set is fixed.
    expect(settled.map(s => s.status).sort()).toEqual(['fulfilled', 'rejected'])
    const reason = (settled.find(s => s.status === 'rejected') as PromiseRejectedResult).reason as Error
    expect(reason.message).toContain(repo)
    expect(reason.message).toContain('200ms')
  })

  it('removes the half-created directory and registration after a killed add', async () => {
    const repo = makeRepo()
    const halfWritten: GitRunner = (args, cwd) => {
      addBeforeTimer(args, cwd)
      return new Promise<string>(() => {})
    }
    const strategy = createWorktreeStrategy({ addTimeoutMs: 300, runWorktreeAdd: halfWritten })

    await expect(strategy.allocate(ctxFor(repo, { agentName: 'w1' }))).rejects.toThrow('timed out')

    expect(fs.existsSync(path.join(repo, '.worktrees', 'w1'))).toBe(false)
    expect(git(['worktree', 'list', '--porcelain'], repo)).not.toContain('.worktrees/w1')
    const retry = await createWorktreeStrategy({}).allocate(ctxFor(repo, { agentName: 'w1' }))
    expect(fs.existsSync(retry.cwd)).toBe(true)
  })

  it('leaves a directory that existed before the add alone when the add times out', async () => {
    const repo = makeRepo()
    const target = path.join(repo, '.worktrees', 'w1')
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'sentinel'), 'keep')
    const strategy = createWorktreeStrategy({
      addTimeoutMs: 200,
      runWorktreeAdd: () => new Promise<string>(() => {}),
    })

    await expect(strategy.allocate(ctxFor(repo, { agentName: 'w1' }))).rejects.toThrow('timed out')

    expect(fs.readFileSync(path.join(target, 'sentinel'), 'utf8')).toBe('keep')
  })

  it('discards a worktree an add created after its timeout, once the late add finishes', async () => {
    const repo = makeRepo()
    const target = path.join(repo, '.worktrees', 'w1')
    const late: GitRunner = async (args, cwd) => {
      await new Promise(resolve => setTimeout(resolve, 400))
      return realAdd(args, cwd)
    }
    const strategy = createWorktreeStrategy({ addTimeoutMs: 100, runWorktreeAdd: late })

    await expect(strategy.allocate(ctxFor(repo, { agentName: 'w1' }))).rejects.toThrow('timed out')

    await vi.waitFor(() => expect(fs.existsSync(target)).toBe(false), { timeout: 5_000 })
    // The repo's own mkdtemp suffix can contain "w1", so match the worktree path.
    await vi.waitFor(
      () => expect(git(['worktree', 'list', '--porcelain'], repo)).not.toContain('.worktrees/w1'),
      { timeout: 5_000 },
    )
  })

  it('kills the filter a timed-out add spawned, and cleans up only after it is gone', async () => {
    const repo = makeRepo()
    const target = path.join(repo, '.worktrees', 'w1')
    // Unique per run, so pgrep never sees a filter from a suite running concurrently on the machine.
    const marker = `sleep 61.${process.pid}${Date.now() % 1_000}`
    git(['config', 'filter.hang.smudge', `sh -c '${marker} & wait'`], repo)
    fs.writeFileSync(path.join(repo, '.gitattributes'), 'README.md filter=hang\n')
    git(['add', '.gitattributes'], repo)
    git(['commit', '-m', 'hang on checkout'], repo)
    const strategy = createWorktreeStrategy({ addTimeoutMs: 1_500 })

    await expect(strategy.allocate(ctxFor(repo, { agentName: 'w1' }))).rejects.toThrow('timed out')

    const survivors = spawnSync('pgrep', ['-f', marker]).stdout.toString().trim()
    expect(survivors).toBe('')
    expect(fs.existsSync(target)).toBe(false)
  }, 20_000)

  it('does not make adds in different repositories wait for each other', async () => {
    const [left, right] = [makeRepo(), makeRepo()]
    let leftStarted!: () => void
    let rightStarted!: () => void
    const leftHasStarted = new Promise<void>(resolve => (leftStarted = resolve))
    const rightHasStarted = new Promise<void>(resolve => (rightStarted = resolve))
    let timer: NodeJS.Timeout | undefined
    const giveUp = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('the add in the other repository never started')), 2_000)
    })
    onTestFinished(() => clearTimeout(timer))
    const leftHoldsItsAddOpen: GitRunner = async (args, cwd) => {
      if (cwd === left) {
        leftStarted()
        await Promise.race([rightHasStarted, giveUp])
      } else rightStarted()
      return realAdd(args, cwd)
    }
    const strategy = createWorktreeStrategy({ runWorktreeAdd: leftHoldsItsAddOpen })

    const allocs = await Promise.all([
      strategy.allocate(ctxFor(left)),
      leftHasStarted.then(() => strategy.allocate(ctxFor(right))),
    ])

    expect(allocs.map(a => a.ref?.gitRoot)).toEqual([left, right])
  })
})

describe('worktree add runs no repository hook (CC-410)', () => {
  /** A repo whose hooks live in the tree under a relative path, as husky sets up. */
  function huskyRepo(): { repo: string; marker: string } {
    const repo = makeRepo()
    git(['config', 'core.hooksPath', '.husky'], repo)
    return { repo, marker: path.join(repo, 'HOOK_RAN') }
  }

  /** Each copy writes its own label, so the marker says which checkout's hook git ran. */
  const writeHook = (dir: string, label: string, marker: string): void => {
    fs.mkdirSync(path.join(dir, '.husky'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, '.husky', 'post-checkout'),
      `#!/bin/sh\necho "${label} $PWD" >> '${marker}'\n`,
      {
        mode: 0o755,
      },
    )
  }

  const ran = (marker: string): string =>
    fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : ''

  it("does not run a hook sitting in the main checkout's working tree", async () => {
    const { repo, marker } = huskyRepo()
    writeHook(repo, 'main', marker)

    const alloc = await worktreeStrategy.allocate(ctxFor(repo))

    expect(fs.existsSync(alloc.cwd)).toBe(true)
    expect(ran(marker)).toBe('')
  })

  it('does not run the hook on a branch it adopts', async () => {
    const { repo, marker } = huskyRepo()
    const ctx = ctxFor(repo, { agentName: 'scout' })
    const first = await worktreeStrategy.allocate(ctx)
    writeHook(first.cwd, 'branch', marker)
    git(['add', '.husky'], first.cwd)
    git(['commit', '-m', 'add post-checkout'], first.cwd)
    fs.rmSync(first.cwd, { recursive: true, force: true })
    writeHook(repo, 'main', marker)

    const second = await worktreeStrategy.allocate(ctx)

    expect(second.ref?.reused).toBe('true')
    expect(ran(marker)).toBe('')
  })

  it("leaves the tree's own hooks working for the agent's later git commands", async () => {
    const { repo, marker } = huskyRepo()
    writeHook(repo, 'tree', marker)
    git(['add', '.husky'], repo)
    git(['commit', '-m', 'add post-checkout'], repo)
    fs.rmSync(marker, { force: true })
    const alloc = await worktreeStrategy.allocate(ctxFor(repo))

    git(['checkout', '-b', 'probe'], alloc.cwd)

    expect(git(['config', '--get', 'core.hooksPath'], alloc.cwd)).toBe('.husky')
    expect(ran(marker)).toBe(`tree ${alloc.cwd}`)
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

/**
 * CC-125. A squash or rebase merge leaves the agent's own commits off main, and
 * GitHub deletes the remote branch, so the commit count alone called landed work
 * unmerged and retire refused.
 */
describe('worktree release after the work landed', () => {
  const withRemote = (repo: string): void => {
    const remote = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'iso-remote-')))
    tmpdirs.push(remote)
    git(['init', '--bare', '-b', 'main'], remote)
    git(['remote', 'add', 'origin', remote], repo)
    git(['push', 'origin', 'main'], repo)
  }

  const squashMerge = (repo: string, branch: string): void => {
    git(['merge', '--squash', branch], repo)
    git(['commit', '-m', 'squashed'], repo)
  }

  it('releases a branch that was squash-merged and whose remote branch was deleted', async () => {
    const repo = makeRepo()
    withRemote(repo)
    const ctx = ctxFor(repo)
    const alloc = await worktreeStrategy.allocate(ctx)
    commitIn(alloc.cwd, 'feature.ts')
    commitIn(alloc.cwd, 'more.ts')
    git(['push', 'origin', 'agent-chat/alice'], alloc.cwd)
    squashMerge(repo, 'agent-chat/alice')
    git(['push', 'origin', 'main', ':agent-chat/alice'], repo)
    git(['fetch', '--prune', 'origin'], repo)

    expect(await worktreeStrategy.release(ctx, alloc)).toBe(true)
    expect(git(['branch', '--list', 'agent-chat/alice'], repo)).toBe('')
  })

  it('releases a branch that was rebase-merged onto a base that had moved on', async () => {
    const repo = makeRepo()
    const ctx = ctxFor(repo)
    const alloc = await worktreeStrategy.allocate(ctx)
    commitIn(alloc.cwd, 'feature.ts')
    commitIn(repo, 'unrelated.ts')
    git(['cherry-pick', 'main..agent-chat/alice'], repo)

    expect(await worktreeStrategy.release(ctx, alloc)).toBe(true)
  })

  it('refuses when only part of the branch landed, and names the missing landing', async () => {
    const repo = makeRepo()
    const ctx = ctxFor(repo)
    const alloc = await worktreeStrategy.allocate(ctx)
    const first = commitIn(alloc.cwd, 'feature.ts')
    commitIn(alloc.cwd, 'more.ts')
    commitIn(repo, 'unrelated.ts')
    git(['cherry-pick', first], repo)

    expect(await worktreeStrategy.release(ctx, alloc)).toBe(false)
    expect(refusalOf(alloc)).toMatch(/work not landed on main/)
  })

  it('names the dirty worktree when that is what refuses', async () => {
    const repo = makeRepo()
    const ctx = ctxFor(repo)
    const alloc = await worktreeStrategy.allocate(ctx)
    fs.writeFileSync(path.join(alloc.cwd, 'scratch.ts'), 'half-finished\n')

    expect(await worktreeStrategy.release(ctx, alloc)).toBe(false)
    expect(refusalOf(alloc)).toBe('uncommitted changes in the worktree')
  })

  it('names the unpushed commit count when a never-merged branch refuses', async () => {
    const repo = makeRepo()
    const ctx = ctxFor(repo)
    const alloc = await worktreeStrategy.allocate(ctx)
    commitIn(alloc.cwd, 'feature.ts')
    commitIn(alloc.cwd, 'more.ts')

    expect(await worktreeStrategy.release(ctx, alloc)).toBe(false)
    expect(refusalOf(alloc)).toMatch(/^2 commit\(s\) not on [0-9a-f]{40}; work not landed on main/)
    expect(git(['branch', '--list', 'agent-chat/alice'], repo)).toContain('agent-chat/alice')
  })

  it('still discards a dirty, never-merged branch when forced', async () => {
    const repo = makeRepo()
    const ctx = ctxFor(repo)
    const alloc = await worktreeStrategy.allocate(ctx)
    commitIn(alloc.cwd, 'feature.ts')
    fs.writeFileSync(path.join(alloc.cwd, 'scratch.ts'), 'half-finished\n')

    expect(await worktreeStrategy.release(ctx, alloc, { force: true })).toBe(true)
    expect(git(['branch', '--list', 'agent-chat/alice'], repo)).toBe('')
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

/**
 * CC-72: a worktree the task system assigned is ADOPTED, not allocated.
 *
 * The distinction is the whole point. Allocating creates a branch and takes a
 * budget slot, and releasing it removes the tree — correct for a worktree this
 * strategy made, destructive for one handed to it that sibling agents may still
 * be working in.
 */
describe('an assigned worktree', () => {
  const assignedIn = (repo: string): string => {
    const at = path.join(repo, 'assigned-wt')
    git(['worktree', 'add', '-b', 'assigned-branch', at], repo)
    return at
  }

  it('is used as-is, without creating a branch or taking a budget slot', async () => {
    const repo = makeRepo()
    const at = assignedIn(repo)
    const before = git(['branch', '--list'], repo)

    // Budget of 1, already spent by the assigned tree, proves adoption does not
    // consume one: an allocating call here would throw WorktreeBudgetExhausted.
    const strategy = createWorktreeStrategy({ budget: 1 })
    const alloc = await strategy.allocate(ctxFor(repo, { assignedWorktree: at }))

    expect(alloc.cwd).toBe(at)
    expect(alloc.ref?.assigned).toBe('true')
    expect(alloc.ref?.branch).toBe('assigned-branch')
    expect(git(['branch', '--list'], repo)).toBe(before)
  })

  it('warns the agent it may be sharing the tree, rather than claiming it owns it', async () => {
    const repo = makeRepo()
    const alloc = await worktreeStrategy.allocate(ctxFor(repo, { assignedWorktree: assignedIn(repo) }))
    expect(alloc.note).toMatch(/sharing it with other agents/)
  })

  it('refuses a path that does not exist, rather than inventing one', async () => {
    const repo = makeRepo()
    await expect(
      worktreeStrategy.allocate(ctxFor(repo, { assignedWorktree: path.join(repo, 'nope') })),
    ).rejects.toThrow(/does not exist/)
  })

  it('survives release, even forced — the task system owns it, not this agent', async () => {
    const repo = makeRepo()
    const at = assignedIn(repo)
    const ctx = ctxFor(repo, { assignedWorktree: at })
    const alloc = await worktreeStrategy.allocate(ctx)

    // force is for discarding THIS agent's unmerged commits, not for seizing a
    // resource that was never ours. Both directions must leave the tree standing.
    expect(await worktreeStrategy.release(ctx, alloc, { force: true })).toBe(true)
    expect(fs.existsSync(at)).toBe(true)
    expect(git(['branch', '--list', 'assigned-branch'], repo)).toContain('assigned-branch')
  })
})
