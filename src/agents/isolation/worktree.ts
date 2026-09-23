import { execFile } from 'node:child_process'
import { cpSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { clearRefusal, recordRefusal } from './refusals.js'
import { warn } from './warnings.js'
import { resolveWorktreeBudget } from '../../config.js'
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

export interface ReleaseCheck {
  name: 'dirty' | 'pushed' | 'landed' | 'gh'
  ok: boolean
  detail: string
}

export interface WorktreeReleaseSafety {
  dirty: boolean
  /** Commits that exist nowhere else: not on the remote, not in the base ref, and not landed. */
  unmerged: boolean
  /** Every file the branch changed already matches the current base: a squash or rebase merge. */
  landed: boolean
  /** Commits on the branch but not on `compareTo`; null when the range could not be counted. */
  ahead: number | null
  checked: ReleaseCheck[]
}

/** The checkout's current branch, and the remote default if one is known locally. */
async function landingTargets(gitRoot: string): Promise<string[]> {
  const head = await gitOrNull(['symbolic-ref', '--quiet', '--short', 'HEAD'], gitRoot)
  const remoteHead = await gitOrNull(['rev-parse', '--verify', '--quiet', 'origin/HEAD'], gitRoot)
  return [head ?? 'HEAD', ...(remoteHead === null ? [] : ['origin/HEAD'])]
}

/**
 * Has the branch's content reached `target`, whatever the commit ids say?
 *
 * A squash or rebase merge leaves the branch's own commits unreachable from the
 * base, so the commit count calls them unmerged. What matters is the content:
 * if every file the branch changed since it forked is identical on `target`,
 * nothing is lost by deleting the branch. A later edit on `target` to one of
 * those files makes this refuse, which is the over-refusal we accept.
 */
async function hasLanded(gitRoot: string, branch: string, target: string): Promise<boolean> {
  if ((await gitOrNull(['diff', '--quiet', target, branch], gitRoot)) !== null) return true
  const base = await gitOrNull(['merge-base', target, branch], gitRoot)
  if (base === null) return false
  const files = await gitOrNull(['diff', '--no-renames', '--name-only', base, branch], gitRoot)
  if (files === null) return false
  const touched = files.split('\n').filter(Boolean)
  if (touched.length === 0) return true
  return (await gitOrNull(['diff', '--quiet', target, branch, '--', ...touched], gitRoot)) !== null
}

async function landedOn(gitRoot: string, branch: string): Promise<string | null> {
  for (const target of await landingTargets(gitRoot)) {
    if (await hasLanded(gitRoot, branch, target)) return target
  }
  return null
}

const GH_TIMEOUT_MS = 3_000

/** Advisory only: never required, never allowed to change the git answer. */
async function ghPrState(gitRoot: string, branch: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['pr', 'view', branch, '--json', 'state', '--jq', '.state'],
      {
        cwd: gitRoot,
        encoding: 'utf8',
        timeout: GH_TIMEOUT_MS,
      },
    )
    return stdout.trim() || null
  } catch {
    return null
  }
}

function dirtyCheck(dirty: boolean): ReleaseCheck {
  return {
    name: 'dirty',
    ok: !dirty,
    detail: dirty ? 'uncommitted changes in the worktree' : 'worktree clean',
  }
}

function pushedCheck(ahead: number | null, compareTo: string): ReleaseCheck {
  if (ahead === null)
    return { name: 'pushed', ok: false, detail: `could not count commits against ${compareTo}` }
  return { name: 'pushed', ok: ahead === 0, detail: `${ahead} commit(s) not on ${compareTo}` }
}

function landedCheck(target: string | null, targets: readonly string[]): ReleaseCheck {
  return target === null
    ? { name: 'landed', ok: false, detail: `work not landed on ${targets.join(' or ')}` }
    : { name: 'landed', ok: true, detail: `work landed on ${target}` }
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
 *
 * CC-125: commits that fail that count are still safe when their content has
 * landed on the checkout's current branch (or `origin/HEAD`), which is how a
 * squash-merged PR looks once GitHub deletes the remote branch. Nothing is
 * fetched: a stale local main makes this refuse until someone pulls.
 */
export async function inspectForRelease(
  gitRoot: string,
  worktreePath: string,
  branch: string,
  baseRef: string,
): Promise<WorktreeReleaseSafety> {
  const status = existsSync(worktreePath) ? await gitOrNull(['status', '--porcelain'], worktreePath) : null
  const dirty = (status ?? '').length > 0
  const checked = [dirtyCheck(dirty)]

  if ((await gitOrNull(['rev-parse', '--verify', branch], gitRoot)) === null)
    return { dirty, unmerged: false, landed: false, ahead: 0, checked }

  const remote = await gitOrNull(['rev-parse', '--verify', `origin/${branch}`], gitRoot)
  const compareTo = remote === null ? baseRef : `origin/${branch}`
  const count = await gitOrNull(['rev-list', '--count', `${compareTo}..${branch}`], gitRoot)
  // An uncountable range means we cannot prove the commits are safe elsewhere.
  const ahead = count === null ? null : Number.parseInt(count, 10)
  checked.push(pushedCheck(ahead, compareTo))
  if (ahead === 0) return { dirty, unmerged: false, landed: false, ahead, checked }

  const targets = await landingTargets(gitRoot)
  const target = await landedOn(gitRoot, branch)
  checked.push(landedCheck(target, targets))
  if (target === null) {
    const state = await ghPrState(gitRoot, branch)
    if (state !== null) checked.push({ name: 'gh', ok: true, detail: `gh reports the PR as ${state}` })
  }
  return { dirty, unmerged: target === null, landed: target !== null, ahead, checked }
}

/** The failed checks, as one line a coordinator can act on. */
export function describeRefusal(safety: WorktreeReleaseSafety): string {
  const failed = safety.checked.filter(c => !c.ok && !(c.name === 'pushed' && safety.landed))
  const advisory = safety.checked.filter(c => c.name === 'gh').map(c => c.detail)
  return [...failed.map(c => c.detail), ...advisory].join('; ')
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

/** Null when release may proceed, otherwise the reason it may not. */
async function refuseRelease(
  ctx: IsolationContext,
  gitRoot: string,
  worktreePath: string,
  branch: string,
  baseRef: string,
): Promise<string | null> {
  if (ctx.exitedAt !== undefined && Date.now() - ctx.exitedAt < RECLAIM_GRACE_MS)
    return `agent exited less than ${RECLAIM_GRACE_MS / 1000}s ago; inside the reclaim grace window`
  const safety = await inspectForRelease(gitRoot, worktreePath, branch, baseRef)
  return safety.dirty || safety.unmerged ? describeRefusal(safety) : null
}

export function createWorktreeStrategy(opts: WorktreeOptions = {}): IsolationStrategy {
  const basePath = opts.basePath ?? DEFAULT_BASE_PATH
  const budgetNow = (): number => opts.budget ?? resolveWorktreeBudget(DEFAULT_BUDGET)

  return {
    name: 'worktree',

    async check(ctx: IsolationContext): Promise<string[]> {
      const gitRoot = await findGitRoot(ctx.baseCwd)
      if (gitRoot === null) return [`${ctx.baseCwd} is not a git repository; worktree isolation needs one`]

      await pruneStaleWorktrees(gitRoot)
      const allocated = await allocatedPaths(gitRoot, basePath)
      const budget = budgetNow()
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

      // An assigned worktree is ADOPTED, not allocated (CC-72): no branch is
      // created, no budget slot is taken, and `assigned` in the ref is what tells
      // release to leave it alone. The task system owns its lifecycle — removing
      // a worktree that sibling tasks are still sharing is exactly the damage
      // this path exists to avoid.
      if (ctx.assignedWorktree !== undefined) {
        const assigned = path.resolve(ctx.assignedWorktree)
        if (!existsSync(assigned)) throw new Error(`assigned worktree ${assigned} does not exist`)
        const branch = (await gitOrNull(['rev-parse', '--abbrev-ref', 'HEAD'], assigned)) ?? 'HEAD'
        return {
          cwd: assigned,
          note: `You are in a worktree assigned to this task at ${assigned}, on branch ${branch}. You may be sharing it with other agents, so stay inside the paths you were given.`,
          ref: { branch, worktree: assigned, gitRoot, assigned: 'true' },
        }
      }

      await pruneStaleWorktrees(gitRoot)
      const allocated = await allocatedPaths(gitRoot, basePath)
      const budget = budgetNow()
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
      clearRefusal(alloc)
      const ref = alloc.ref
      if (!ref?.branch || !ref.worktree || !ref.gitRoot) {
        recordRefusal(alloc, 'allocation carries no worktree reference')
        return false
      }
      const { branch, worktree: worktreePath, gitRoot } = ref

      // Release only what this strategy created. An assigned worktree belongs to
      // the task system, may be shared with sibling agents still working in it,
      // and may hold a branch someone else opened a PR from — so retiring one
      // agent must not take it away. `--force` does NOT override this: force
      // exists to discard THIS agent's unmerged commits, not to seize a resource
      // that was never ours. Returning true reports the release as complete,
      // because for this agent it is: there is nothing of ours left to clean up.
      if (ref.assigned === 'true') return true

      if (!releaseOpts.force) {
        const refusal = await refuseRelease(ctx, gitRoot, worktreePath, branch, ref.base ?? 'HEAD')
        if (refusal !== null) {
          recordRefusal(alloc, refusal)
          return false
        }
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
