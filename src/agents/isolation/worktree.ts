import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  createWorktreeAllocator,
  describeRefusal,
  inspectForRelease as inspectWithPackage,
  runGit as gitOrNull,
  MissingAssignedWorktreeRecordError,
  pruneStaleWorktrees,
  reattachWorktree as platformReattach,
  recreateWorktree as platformRecreate,
  type ReleaseCheck,
  type ReleaseProof,
  type WorktreeAllocation,
  type WorktreeOptions as PlatformOptions,
  type WorktreeRecord,
  type WorktreeReleaseSafety,
} from '@titan-design/worktree'
import { clearRefusal, recordRefusal } from './refusals.js'
import { warn } from './warnings.js'
import { unsavedWork } from './unsaved-work.js'
import { setupWorktree, type SetupRunner } from './worktree-setup.js'
import { resolveReviewerWorktreeBudget, resolveWorktreeBudget } from '../../config.js'
import { isReviewerTreeName } from '../reviewer-tree.js'
import { findGitRoot } from '../../git.js'
import type { Allocation, IsolationContext, IsolationStrategy, ReleaseOptions } from './index.js'

export { describeRefusal, findGitRoot, pruneStaleWorktrees }
export {
  DEFAULT_FETCH_TIMEOUT_MS,
  fetchDefaultTip,
  OriginUnreachableError,
  resolveBranchBase,
  resolveRequestedBase,
  WorktreeInUseError,
} from '@titan-design/worktree'
export type { BranchBase, ReleaseCheck, WorktreeReleaseSafety, WorktreeRecord } from '@titan-design/worktree'

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

/** Tree directory name to the name of whoever spawned the agent in it. */
export type TreeHolders = () => ReadonlyMap<string, string>

const UNKNOWN_HOLDER = 'unknown'

/**
 * CC-1469: a refused coordinator needs to know whether its own trees or another seat's fill the
 * pool. Each tree is charged to its agent's direct spawner, largest holder first.
 */
export function heldBy(trees: readonly string[], holders: ReadonlyMap<string, string>): string {
  const counts = new Map<string, number>()
  for (const tree of trees) {
    const holder = holders.get(tree) ?? UNKNOWN_HOLDER
    counts.set(holder, (counts.get(holder) ?? 0) + 1)
  }
  const ranked = [...counts].sort(([a, m], [b, n]) => n - m || a.localeCompare(b))
  return ranked.length === 0 ? '' : `; held by ${ranked.map(([who, n]) => `${who} ${n}`).join(', ')}`
}

/** Newest identity first, so a reused name charges its tree to the latest spawner. */
export function treeHoldersOf(
  agents: readonly { name: string; spawnedBy: string }[],
): ReadonlyMap<string, string> {
  const holders = new Map<string, string>()
  for (const { name, spawnedBy } of agents)
    if (!holders.has(slug(name))) holders.set(slug(name), spawnedBy || UNKNOWN_HOLDER)
  return holders
}

const holdingsOf = (use: PoolUse, holders: TreeHolders | undefined): string =>
  heldBy(use.trees, holders?.() ?? new Map())

export class WorktreeBudgetExhaustedError extends Error {
  constructor(
    readonly allocated: number,
    readonly budget: number,
    readonly pool: WorktreePool = 'implementer',
    holdings = '',
  ) {
    super(poolExhausted(pool, allocated, budget) + holdings)
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
  /** CC-1469: read only when a pool refuses, to say who holds its trees. */
  treeHolders?: TreeHolders
}

export type GitRunner = (args: readonly string[], cwd: string) => Promise<string>

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
  /** Directory names of the pool's trees. */
  trees: string[]
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
  const trees = (await allocatedPaths(gitRoot, basePath))
    .map(dir => path.basename(dir))
    .filter(name => poolOf(name) === pool)
  const budget =
    pool === 'reviewer'
      ? (opts.reviewerBudget ?? resolveReviewerWorktreeBudget(DEFAULT_REVIEWER_WORKTREE_BUDGET))
      : (opts.budget ?? resolveWorktreeBudget(DEFAULT_WORKTREE_BUDGET))
  return { pool, allocated: trees.length, budget, trees }
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

/**
 * A repository that does not ignore its worktree directory would show it untracked, and an
 * untracked dir is a dirty primary tree (CC-916). The repo-local exclude file is not tracked,
 * so listing it there leaves the tree clean without a commit. Package 0.3.0 does not do this.
 */
async function excludeBasePath(gitRoot: string, basePath: string): Promise<void> {
  const file = await gitOrNull(['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], gitRoot)
  if (file === null) return
  const entry = `/${basePath.replace(/^\.?\/+|\/+$/g, '')}/`
  try {
    const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
    if (current.split('\n').includes(entry)) return
    mkdirSync(path.dirname(file), { recursive: true })
    appendFileSync(file, `${current === '' || current.endsWith('\n') ? '' : '\n'}${entry}\n`)
  } catch {
    // Best effort: the worktree itself is already cut, and a gitignore may cover it.
  }
}

/** Product wording for package refusals; CC-1469 adds the holder breakdown, which the budget hook cannot see. */
async function productAllocationError(
  err: unknown,
  ctx: IsolationContext,
  basePath: string,
  opts: WorktreeOptions,
): Promise<unknown> {
  if (err instanceof MissingAssignedWorktreeRecordError)
    return new Error(
      `assigned worktree ${err.worktreePath} does not exist, and agent-chat has no record of allocating it ` +
        'to re-create it from. Not spawned',
    )
  if (!(err instanceof WorktreeBudgetExhaustedError)) return err
  const gitRoot = await findGitRoot(ctx.baseCwd)
  if (gitRoot === null) return err
  const use = await poolUse(gitRoot, basePath, slug(ctx.agentName), opts)
  const holdings = holdingsOf(use, ctx.treeHolders ?? opts.treeHolders)
  return new WorktreeBudgetExhaustedError(err.allocated, err.budget, err.pool, holdings)
}

const UNCOMMITTED = 'uncommitted changes in the worktree'

/**
 * Is it safe to destroy this worktree and its branch? Commits are judged by the package; the
 * tree's files by agent-chat's own ignored-file policy, the one park uses, since the package's
 * list misses this repo's build outputs (`*.tsbuildinfo`) and would hold every built tree.
 */
export async function inspectForRelease(
  gitRoot: string,
  worktreePath: string,
  branch: string,
  baseRef: string,
  releaseProof: ReleaseProof = 'git',
): Promise<WorktreeReleaseSafety> {
  const safety = await inspectWithPackage(gitRoot, worktreePath, branch, baseRef, releaseProof)
  const unsaved = existsSync(worktreePath) ? await unsavedWork(worktreePath, 'release') : undefined
  const detail =
    unsaved === undefined ? 'worktree clean' : unsaved.kind === 'changes' ? UNCOMMITTED : unsaved.detail
  const dirty: ReleaseCheck = { name: 'dirty', ok: unsaved === undefined, detail }
  const rest = safety.checked.filter(check => check.name !== 'dirty')
  return { ...safety, dirty: unsaved !== undefined, checked: [dirty, ...rest] }
}

type TreeRef = { branch: string; worktree: string; gitRoot: string; base?: string }

/** Without --force, so git itself still refuses a tree that gained untracked or modified files. */
async function removeTree({ gitRoot, worktree, branch }: TreeRef): Promise<string | undefined> {
  const removed = await gitOrNull(['worktree', 'remove', worktree], gitRoot)
  if (removed === null && existsSync(worktree)) return `git would not remove ${worktree}`
  await pruneStaleWorktrees(gitRoot)
  await gitOrNull(['branch', '-D', branch], gitRoot)
  return undefined
}

/** The unforced release, judged by product policy rather than the allocator's own inspection. */
async function releaseInspected(stoppedAt: number | undefined, ref: TreeRef): Promise<string | undefined> {
  if (stoppedAt !== undefined && Date.now() - stoppedAt < RECLAIM_GRACE_MS)
    return `agent stopped less than ${RECLAIM_GRACE_MS / 1000}s ago; inside the reclaim grace window`
  const base = ref.base ?? 'HEAD'
  const safety = await inspectForRelease(ref.gitRoot, ref.worktree, ref.branch, base, 'git-or-merged-pr-tip')
  if (safety.dirty || safety.unmerged) return describeRefusal(safety)
  return removeTree(ref)
}

/** A tree this strategy cut and may remove; forced, parked, assigned and ref-less releases stay with the package. */
function ownedTree(allocation: Allocation, opts: ReleaseOptions): TreeRef | undefined {
  const ref = allocation.ref
  if (opts.force === true || opts.keepBranch === true || ref?.assigned === 'true') return undefined
  if (!ref?.branch || !ref.worktree || !ref.gitRoot) return undefined
  return {
    branch: ref.branch,
    worktree: ref.worktree,
    gitRoot: ref.gitRoot,
    ...(ref.base ? { base: ref.base } : {}),
  }
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
        reasons.push(
          `${poolExhausted(use.pool, use.allocated, use.budget)} under ${basePath}` +
            holdingsOf(use, ctx.treeHolders),
        )
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
      const allocation = await allocator.allocate(ctx).catch(async (err: unknown) => {
        throw await productAllocationError(err, ctx, basePath, opts)
      })
      const gitRoot = allocation.ref.gitRoot
      if (allocation.ref.assigned !== 'true' && gitRoot !== undefined)
        await excludeBasePath(gitRoot, basePath)
      return decorateAllocation(allocation, opts, ctx.baseRef)
    },

    async release(
      ctx: IsolationContext,
      allocation: Allocation,
      opts: ReleaseOptions = {},
    ): Promise<boolean> {
      clearRefusal(allocation)
      const owned = ownedTree(allocation, opts)
      if (owned !== undefined) {
        const refusal = await releaseInspected(ctx.stoppedAt, owned)
        if (refusal !== undefined) recordRefusal(allocation, refusal)
        return refusal === undefined
      }
      const result = await allocator.release(
        ctx.stoppedAt === undefined ? {} : { exitedAt: ctx.stoppedAt },
        allocation,
        opts,
      )
      if (!result.released) recordRefusal(allocation, result.refusal)
      return result.released
    },
  }
}

export const worktreeStrategy = createWorktreeStrategy()
