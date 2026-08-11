import { execFile } from 'node:child_process'
import { cpSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { warn } from './warnings.js'
import { findGitRoot } from '../../git.js'
import type { Allocation, IsolationContext, IsolationStrategy, ReleaseOptions } from './index.js'

// Re-exported because this module was its original home and callers (and tests)
// still reach for it here; the implementation moved to `src/git.ts` so the MCP
// subprocess can resolve a worktree without importing an isolation strategy.
export { findGitRoot }

const execFileAsync = promisify(execFile)

const DEFAULT_BUDGET = 3
const DEFAULT_BASE_PATH = '.worktrees'
export const BRANCH_PREFIX = 'agent-chat/'

/**
 * Grace window between an agent exiting and its worktree becoming reclaimable.
 *
 * In brain this guarded a racing push/PR. Here it guards a narrower but more
 * common thing: the window between the `agent_exited` row and a human noticing
 * the agent left unpushed commits behind. Release does `git branch -D`, so
 * reclaiming inside that window turns "I'll look at it in a minute" into a
 * dangling commit. Anchored on the `agent_exited` timestamp, not on wall clock
 * since allocation.
 *
 * This window and the dirty/unmerged refusal below are the two things most
 * likely to be dropped as incidental. They are not — both exist because work
 * was actually lost.
 */
export const RECLAIM_GRACE_MS = 120_000

export class WorktreeBudgetExhaustedError extends Error {
  constructor(
    readonly allocated: number,
    readonly budget: number,
  ) {
    super(`Worktree budget exhausted: ${allocated}/${budget} allocated`)
    this.name = 'WorktreeBudgetExhaustedError'
  }
}

export interface WorktreeOptions {
  /** Relative to the git root. */
  basePath?: string
  budget?: number
}

async function git(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd, encoding: 'utf8' })
  return stdout.trim()
}

/** git failures are routine control flow here — "does this ref exist" is a failing command. */
async function gitOrNull(args: readonly string[], cwd: string): Promise<string | null> {
  try {
    return await git(args, cwd)
  } catch {
    return null
  }
}

/** A name reaches this from a model, so it must not be able to escape basePath. */
const slug = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '') || 'agent'

const branchFor = (name: string): string => `${BRANCH_PREFIX}${slug(name)}`

/** Live worktrees under basePath, from git itself rather than a parallel table. */
async function allocatedPaths(gitRoot: string, basePath: string): Promise<string[]> {
  const out = await gitOrNull(['worktree', 'list', '--porcelain'], gitRoot)
  if (out === null) return []
  const base = path.resolve(gitRoot, basePath) + path.sep
  return out
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => path.resolve(line.slice('worktree '.length).trim()))
    .filter(dir => dir.startsWith(base))
}

/**
 * Drop registrations whose directory is gone from disk, so a machine that was
 * rebooted mid-run does not permanently hold budget it is not using.
 */
export async function pruneStaleWorktrees(gitRoot: string): Promise<void> {
  await gitOrNull(['worktree', 'prune'], gitRoot)
}

export interface WorktreeReleaseSafety {
  dirty: boolean
  /** Commits that exist nowhere else: not on the remote, not in the base ref. */
  unmerged: boolean
}

/**
 * Is it safe to destroy this worktree and its branch?
 *
 * Divergence from the brain lift, deliberately: brain compared against
 * `origin/main` and treated "no remote" as safe, which is fine for a repo that
 * always has one. agent-chat runs against local checkouts that may have no
 * remote at all, where that reading would silently delete every commit the agent
 * made. So the comparison falls back to the commit the branch forked from, and
 * over-refusal is the failure mode we accept — `force` is one flag away.
 */
export async function inspectForRelease(
  gitRoot: string,
  worktreePath: string,
  branch: string,
  baseRef: string,
): Promise<WorktreeReleaseSafety> {
  const status = existsSync(worktreePath) ? await gitOrNull(['status', '--porcelain'], worktreePath) : null
  const dirty = (status ?? '').length > 0

  if ((await gitOrNull(['rev-parse', '--verify', branch], gitRoot)) === null)
    return { dirty, unmerged: false }

  const remote = await gitOrNull(['rev-parse', '--verify', `origin/${branch}`], gitRoot)
  const compareTo = remote === null ? baseRef : `origin/${branch}`
  const ahead = await gitOrNull(['rev-list', '--count', `${compareTo}..${branch}`], gitRoot)
  // An uncountable range means we cannot prove the commits are safe elsewhere.
  return { dirty, unmerged: ahead === null || Number.parseInt(ahead, 10) > 0 }
}

/**
 * Adoption is impossible: something is still holding the branch or the path.
 *
 * Distinct from "the branch holds work", which is recoverable by adopting it.
 * This one means a live agent of the same name already has the worktree, or a
 * directory is sitting in the way — cases where proceeding would clobber files
 * nobody has agreed to lose.
 */
export class WorktreeInUseError extends Error {
  constructor(
    readonly branch: string,
    readonly worktreePath: string,
  ) {
    super(
      `${worktreePath} is still on disk and holds branch ${branch}. Another agent of this name may be ` +
        'live. Release it, spawn under a different name, or force the allocation to discard it.',
    )
    this.name = 'WorktreeInUseError'
  }
}

/** The worktree currently holding `branch`, or null. Prune first, or this lies. */
async function checkoutOf(gitRoot: string, branch: string): Promise<string | null> {
  const out = (await gitOrNull(['worktree', 'list', '--porcelain'], gitRoot)) ?? ''
  const blocks = out.split('\n\n')
  const holder = blocks.find(block => block.includes(`branch refs/heads/${branch}`))
  const line = holder?.split('\n').find(l => l.startsWith('worktree '))
  return line ? path.resolve(line.slice('worktree '.length).trim()) : null
}

/** Hooks and settings live in gitignored .claude/, so a fresh worktree runs unhooked without this. */
function copyClaudeDir(gitRoot: string, worktreePath: string): void {
  const source = path.resolve(gitRoot, '.claude')
  const target = path.resolve(worktreePath, '.claude')
  if (existsSync(source) && !existsSync(target)) cpSync(source, target, { recursive: true })
}

async function resetTo(gitRoot: string, branch: string, worktreePath: string): Promise<void> {
  await gitOrNull(['worktree', 'remove', '--force', worktreePath], gitRoot)
  rmSync(worktreePath, { recursive: true, force: true })
  await gitOrNull(['branch', '-D', branch], gitRoot)
  await git(['worktree', 'add', '-b', branch, worktreePath], gitRoot)
}

/**
 * Attach a worktree for `branch`, and return whether an existing branch was adopted.
 *
 * The crash path this exists for, which the release-side check does not cover:
 * an agent commits, then dies without ever calling release. Its worktree
 * directory is gone but the branch still holds the only copy of those commits.
 * An unconditional `branch -D` here would make them unreachable — reflog-only,
 * and GC bait. `check()` warns about the leftover branch, but a warning is
 * advisory and the supervisor may proceed past it, so the guard has to live
 * where the destruction actually happens.
 *
 * Adopting beats refusing: a respawn under the same name IS that agent
 * continuing, so handing it back its own branch is what the operator wanted, and
 * it needs no human rescue. A branch holding nothing worth keeping is still
 * reset, so an agent does not silently inherit a stale base.
 */
async function attachWorktree(
  gitRoot: string,
  branch: string,
  worktreePath: string,
  opts: { base: string; force: boolean },
): Promise<boolean> {
  if ((await gitOrNull(['rev-parse', '--verify', branch], gitRoot)) === null) {
    await git(['worktree', 'add', '-b', branch, worktreePath], gitRoot)
    copyClaudeDir(gitRoot, worktreePath)
    return false
  }

  if (opts.force) {
    await resetTo(gitRoot, branch, worktreePath)
    copyClaudeDir(gitRoot, worktreePath)
    return false
  }

  const holder = await checkoutOf(gitRoot, branch)
  if (holder !== null || existsSync(worktreePath))
    throw new WorktreeInUseError(branch, holder ?? worktreePath)

  const safety = await inspectForRelease(gitRoot, worktreePath, branch, opts.base)
  if (safety.unmerged) await git(['worktree', 'add', worktreePath, branch], gitRoot)
  else await resetTo(gitRoot, branch, worktreePath)

  copyClaudeDir(gitRoot, worktreePath)
  return safety.unmerged
}

export function createWorktreeStrategy(opts: WorktreeOptions = {}): IsolationStrategy {
  const basePath = opts.basePath ?? DEFAULT_BASE_PATH
  const budget = opts.budget ?? DEFAULT_BUDGET

  return {
    name: 'worktree',

    async check(ctx: IsolationContext): Promise<string[]> {
      const gitRoot = await findGitRoot(ctx.baseCwd)
      if (gitRoot === null) return [`${ctx.baseCwd} is not a git repository; worktree isolation needs one`]

      await pruneStaleWorktrees(gitRoot)
      const allocated = await allocatedPaths(gitRoot, basePath)
      const reasons: string[] = []
      if (allocated.length >= budget) {
        reasons.push(`worktree budget exhausted: ${allocated.length}/${budget} allocated under ${basePath}`)
      }
      if ((await gitOrNull(['rev-parse', '--verify', branchFor(ctx.agentName)], gitRoot)) !== null) {
        reasons.push(
          warn(
            `branch ${branchFor(ctx.agentName)} already exists; it will be adopted if it holds commits, ` +
              'reset if it does not',
          ),
        )
      }
      return reasons
    },

    async allocate(ctx: IsolationContext): Promise<Allocation> {
      const gitRoot = await findGitRoot(ctx.baseCwd)
      if (gitRoot === null) throw new Error(`${ctx.baseCwd} is not a git repository`)

      await pruneStaleWorktrees(gitRoot)
      const allocated = await allocatedPaths(gitRoot, basePath)
      if (allocated.length >= budget) throw new WorktreeBudgetExhaustedError(allocated.length, budget)

      const branch = branchFor(ctx.agentName)
      const worktreePath = path.resolve(gitRoot, basePath, slug(ctx.agentName))
      const base = (await gitOrNull(['rev-parse', 'HEAD'], gitRoot)) ?? 'HEAD'
      const reused = await attachWorktree(gitRoot, branch, worktreePath, {
        base,
        force: ctx.forceReset === true,
      })

      const carried = reused ? ' It already carries commits from an earlier run under this name.' : ''
      return {
        cwd: worktreePath,
        note: `You are on branch ${branch} in an isolated worktree at ${worktreePath}.${carried} Commit your work there; nothing outside it is yours to change.`,
        ref: { branch, worktree: worktreePath, gitRoot, base, ...(reused ? { reused: 'true' } : {}) },
      }
    },

    /**
     * Returns false when it REFUSED — dirty, unmerged, or still inside the grace
     * window — as distinct from failing. A refusal leaves everything on disk.
     */
    async release(
      ctx: IsolationContext,
      alloc: Allocation,
      releaseOpts: ReleaseOptions = {},
    ): Promise<boolean> {
      const ref = alloc.ref
      if (!ref?.branch || !ref.worktree || !ref.gitRoot) return false
      const { branch, worktree: worktreePath, gitRoot } = ref

      if (!releaseOpts.force) {
        if (ctx.exitedAt !== undefined && Date.now() - ctx.exitedAt < RECLAIM_GRACE_MS) return false
        const safety = await inspectForRelease(gitRoot, worktreePath, branch, ref.base ?? 'HEAD')
        if (safety.dirty || safety.unmerged) return false
      }

      if ((await gitOrNull(['worktree', 'remove', worktreePath], gitRoot)) === null) {
        await gitOrNull(['worktree', 'remove', '--force', worktreePath], gitRoot)
      }
      await gitOrNull(['branch', '-D', branch], gitRoot)
      await pruneStaleWorktrees(gitRoot)
      return true
    },
  }
}

export const worktreeStrategy = createWorktreeStrategy()
