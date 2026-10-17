import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  createWorktreeAllocator,
  MissingAssignedWorktreeRecordError,
  pruneStaleWorktrees,
  reattachWorktree as platformReattach,
  recreateWorktree as platformRecreate,
  type WorktreeAllocation,
  type WorktreeOptions as PlatformOptions,
  type WorktreeRecord,
} from '@titan-design/worktree'
import { clearRefusal, recordRefusal } from './refusals.js'
import { warn } from './warnings.js'
import { setupWorktree, type SetupRunner } from './worktree-setup.js'
import { resolveReviewerWorktreeBudget, resolveWorktreeBudget } from '../../config.js'
import { isReviewerTreeName } from '../reviewer-tree.js'
import { findGitRoot, gitChildEnv } from '../../git.js'
import type { Allocation, IsolationContext, IsolationStrategy, ReleaseOptions } from './index.js'

export { findGitRoot, pruneStaleWorktrees }
export {
  describeRefusal,
  inspectForRelease,
  OriginUnreachableError,
  resolveBranchBase,
  resolveRequestedBase,
  WorktreeInUseError,
} from '@titan-design/worktree'
export type { ReleaseCheck, WorktreeReleaseSafety, WorktreeRecord } from '@titan-design/worktree'

const execFileAsync = promisify(execFile)

export const DEFAULT_WORKTREE_BUDGET = 3
/** CC-1040: Shepherd's reviewer cap, so a full reviewer round never waits on implementer slots. */
export const DEFAULT_REVIEWER_WORKTREE_BUDGET = 8
const DEFAULT_BASE_PATH = '.worktrees'
export const BRANCH_PREFIX = 'agent-chat/'

/** Five minutes: a cold checkout of a multi-gigabyte repo takes tens of seconds, so only a hang reaches it. */
export const WORKTREE_ADD_TIMEOUT_MS = 300_000

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

export type WorktreePool = 'implementer' | 'reviewer'

const POOL_BUDGET_KEY: Record<WorktreePool, string> = {
  implementer: 'worktreeBudget',
  reviewer: 'reviewerWorktreeBudget',
}

const poolExhausted = (pool: WorktreePool, allocated: number, budget: number): string =>
  `${pool} worktree pool exhausted: ${allocated}/${budget} allocated ` +
  `(budget exhausted: ${allocated}/${budget}, ${POOL_BUDGET_KEY[pool]})`

export class WorktreeBudgetExhaustedError extends Error {
  constructor(
    readonly allocated: number,
    readonly budget: number,
    readonly pool: WorktreePool = 'implementer',
  ) {
    super(poolExhausted(pool, allocated, budget))
    this.name = 'WorktreeBudgetExhaustedError'
  }
}

export interface WorktreeOptions {
  /** Relative to the git root. */
  basePath?: string
  budget?: number
  /** Reviewer pool size; read from `reviewerWorktreeBudget` per spawn when absent. */
  reviewerBudget?: number
  /** Bound on fetching origin's default branch before cutting a new one. */
  fetchTimeoutMs?: number
  /** Bound on one `git worktree add`; the add is killed and the repo's queue moves on when it passes. */
  addTimeoutMs?: number
  /** Runs each `git worktree add`; tests inject one to observe how adds interleave. */
  runWorktreeAdd?: GitRunner
  /** Runs the repository's declared setup step; tests inject one so no real install runs. */
  runSetup?: SetupRunner
}

export type GitRunner = (args: readonly string[], cwd: string) => Promise<string>

async function git(args: readonly string[], cwd: string, timeout?: number): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: gitChildEnv(),
    ...(timeout === undefined ? {} : { timeout }),
  })
  return stdout.trim()
}

/** git failures are routine control flow here — "does this ref exist" is a failing command. */
async function gitOrNull(args: readonly string[], cwd: string, timeout?: number): Promise<string | null> {
  try {
    return await git(args, cwd, timeout)
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

export interface PoolUse {
  pool: WorktreePool
  allocated: number
  budget: number
}

const poolOf = (name: string): WorktreePool => (isReviewerTreeName(name) ? 'reviewer' : 'implementer')

/** CC-1040: trees under basePath in the same pool as `agentName`, against that pool's budget. */
async function poolUse(
  gitRoot: string,
  basePath: string,
  agentName: string,
  opts: WorktreeOptions,
): Promise<PoolUse> {
  const pool = poolOf(agentName)
  const allocated = (await allocatedPaths(gitRoot, basePath)).filter(
    dir => poolOf(path.basename(dir)) === pool,
  )
  const budget =
    pool === 'reviewer'
      ? (opts.reviewerBudget ?? resolveReviewerWorktreeBudget(DEFAULT_REVIEWER_WORKTREE_BUDGET))
      : (opts.budget ?? resolveWorktreeBudget(DEFAULT_WORKTREE_BUDGET))
  return { pool, allocated: allocated.length, budget }
}

export const DEFAULT_FETCH_TIMEOUT_MS = 15_000

/** The commit a new branch is cut from, the ref it was read from, and a warning when that ref is not origin's. */
export interface BranchBase {
  sha: string
  ref: string
  warning?: string
}

/** origin/HEAD when this clone knows it; otherwise the two conventional names, in order. */
async function defaultBranchCandidates(gitRoot: string): Promise<string[]> {
  const head = await gitOrNull(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], gitRoot)
  return head?.startsWith('origin/') ? [head.slice('origin/'.length)] : ['main', 'master']
}

/** Fetch only: it moves a remote-tracking ref and never the main checkout's HEAD or files. */
async function fetchTip(gitRoot: string, branch: string, timeoutMs: number): Promise<string | null> {
  const tracking = `refs/remotes/origin/${branch}`
  const fetched = await gitOrNull(
    ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${branch}:${tracking}`],
    gitRoot,
    timeoutMs,
  )
  return fetched === null ? null : gitOrNull(['rev-parse', '--verify', `${tracking}^{commit}`], gitRoot)
}

/** The timeout is one budget shared by every candidate, not one per candidate. */
export async function fetchDefaultTip(gitRoot: string, timeoutMs: number): Promise<BranchBase | string> {
  if ((await gitOrNull(['remote', 'get-url', 'origin'], gitRoot)) === null)
    return 'the repository has no origin remote'
  const deadline = Date.now() + timeoutMs
  const candidates = await defaultBranchCandidates(gitRoot)
  for (const branch of candidates) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    const sha = await fetchTip(gitRoot, branch, remaining)
    if (sha !== null) return { sha, ref: `origin/${branch}` }
  }
  return `fetching ${candidates.map(b => `origin/${b}`).join(' or ')} failed or timed out`
}

async function recordStackBase(
  gitRoot: string,
  branch: string,
  baseRef: string | undefined,
): Promise<string[]> {
  const key = `branch.${branch}.agent-chat-base`
  if (baseRef === undefined) {
    await gitOrNull(['config', '--unset', key], gitRoot)
    return []
  }
  const parent = baseRef.slice('origin/'.length)
  if ((await gitOrNull(['config', key, parent], gitRoot)) !== null) return []
  return [warn(`could not record ${key}=${parent}; pr-ready may not find this branch's stack base`)]
}

function dependencyNote(outcome: string | undefined): string {
  return outcome === 'ran'
    ? "The repository's setup step reinstalled its dependencies; build outputs such as dist were not rebuilt, so build before relying on them."
    : 'Ignored files such as node_modules and dist were not restored and no setup step reinstalled them, so install dependencies and build before running checks.'
}

function platformOptions(opts: WorktreeOptions): PlatformOptions {
  return {
    ...(opts.basePath === undefined ? {} : { basePath: opts.basePath }),
    branchPrefix: BRANCH_PREFIX,
    releaseProof: 'git-or-merged-pr-tip',
    ...(opts.fetchTimeoutMs === undefined ? {} : { fetchTimeoutMs: opts.fetchTimeoutMs }),
    ...(opts.addTimeoutMs === undefined ? {} : { addTimeoutMs: opts.addTimeoutMs }),
    ...(opts.runWorktreeAdd === undefined ? {} : { runWorktreeAdd: opts.runWorktreeAdd }),
    skipSetup: true,
    allocationGroup: poolOf,
    budget: name =>
      poolOf(name) === 'reviewer'
        ? (opts.reviewerBudget ?? resolveReviewerWorktreeBudget(DEFAULT_REVIEWER_WORKTREE_BUDGET))
        : (opts.budget ?? resolveWorktreeBudget(DEFAULT_WORKTREE_BUDGET)),
    budgetError: (allocated, budget, name) =>
      new WorktreeBudgetExhaustedError(allocated, budget, poolOf(name)),
  }
}

/** Keep product setup authority/outcomes unchanged while the engine suppresses its own setup. */
async function decorateAllocation(
  allocation: WorktreeAllocation,
  opts: WorktreeOptions,
  baseRef?: string,
): Promise<Allocation> {
  const { branch, worktree, gitRoot, base, base_ref: baseRefUsed, reattached, assigned } = allocation.ref
  if (!branch || !worktree || !gitRoot || !base || !baseRefUsed) return allocation
  const metadataWarnings =
    reattached || assigned === 'true' ? [] : await recordStackBase(gitRoot, branch, baseRef)
  const setup = await setupWorktree(
    { gitRoot, worktree, baseSha: base, fetched: baseRefUsed.startsWith('origin/') },
    opts.runSetup,
  )
  const warnings = [...(allocation.warnings ?? []), ...metadataWarnings, ...setup.warnings]
  const dependency = dependencyNote(setup.outcome)
  const note = !reattached
    ? allocation.note
    : assigned === 'true'
      ? `The worktree assigned to this task at ${worktree} had been removed and was re-created on branch ${branch}. ${dependency} You may be sharing it with other agents, so stay inside the paths you were given.`
      : `Your worktree at ${worktree} had been removed and was re-created on branch ${branch}. ${dependency} Commit your work there; nothing outside it is yours to change.`
  return {
    ...allocation,
    note,
    ref: { ...allocation.ref, ...(reattached ? { setup: setup.outcome } : {}) },
    ...(warnings.length ? { warnings } : {}),
  }
}

export async function reattachWorktree(
  record: WorktreeRecord,
  opts: WorktreeOptions = {},
  requireBranch = false,
): Promise<Allocation> {
  return decorateAllocation(await platformReattach(record, platformOptions(opts), requireBranch), opts)
}

export async function recreateWorktree(
  record: WorktreeRecord,
  opts: WorktreeOptions = {},
): Promise<Allocation> {
  return decorateAllocation(await platformRecreate(record, platformOptions(opts)), opts)
}

export function createWorktreeStrategy(opts: WorktreeOptions = {}): IsolationStrategy {
  const basePath = opts.basePath ?? DEFAULT_BASE_PATH
  const allocator = createWorktreeAllocator(platformOptions(opts))
  return {
    name: 'worktree',
    async check(ctx: IsolationContext): Promise<string[]> {
      const gitRoot = await findGitRoot(ctx.baseCwd)
      if (gitRoot === null) return [`${ctx.baseCwd} is not a git repository; worktree isolation needs one`]

      await pruneStaleWorktrees(gitRoot)
      const use = await poolUse(gitRoot, basePath, slug(ctx.agentName), opts)
      const reasons: string[] = []
      if (use.allocated >= use.budget)
        reasons.push(`${poolExhausted(use.pool, use.allocated, use.budget)} under ${basePath}`)
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
      let allocation: WorktreeAllocation
      try {
        allocation = await allocator.allocate(ctx)
      } catch (error) {
        if (error instanceof MissingAssignedWorktreeRecordError)
          throw new Error(
            `assigned worktree ${error.worktreePath} does not exist, and agent-chat has no record of allocating it ` +
              'to re-create it from. Not spawned',
          )
        throw error
      }
      return decorateAllocation(allocation, opts, ctx.baseRef)
    },

    async release(
      ctx: IsolationContext,
      allocation: Allocation,
      opts: ReleaseOptions = {},
    ): Promise<boolean> {
      clearRefusal(allocation)
      const result = await allocator.release(
        ctx.stoppedAt === undefined ? {} : { exitedAt: ctx.stoppedAt },
        allocation,
        opts,
      )
      if (!result.released)
        recordRefusal(
          allocation,
          result.refusalCode === 'unsaved-changes' ? 'uncommitted changes in the worktree' : result.refusal,
        )
      return result.released
    },
  }
}

export const worktreeStrategy = createWorktreeStrategy()
