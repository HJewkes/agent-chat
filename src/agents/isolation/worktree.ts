import { execFile, spawn } from 'node:child_process'
import { cpSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { clearRefusal, recordRefusal } from './refusals.js'
import { warn } from './warnings.js'
import { runWorktreeSetup, type SetupRunner, type SetupTarget } from './worktree-setup.js'
import { resolveWorktreeBudget } from '../../config.js'
import { findGitRoot, gitChildEnv } from '../../git.js'
import type { Allocation, IsolationContext, IsolationStrategy, ReleaseOptions } from './index.js'

// Re-exported because this module was its original home and callers (and tests)
// still reach for it here; the implementation moved to `src/git.ts` so the MCP
// subprocess can resolve a worktree without importing an isolation strategy.
export { findGitRoot }

const execFileAsync = promisify(execFile)

export const DEFAULT_WORKTREE_BUDGET = 3
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
async function fetchDefaultTip(gitRoot: string, timeoutMs: number): Promise<BranchBase | string> {
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

/** Concurrent fetches of one ref race on its lock and the loser fails, so spawns in a repo share one. */
const inflightBases = new Map<string, Promise<BranchBase>>()

/**
 * CC-151: the main checkout's HEAD may lag origin or hold another session's
 * unpushed commits, and a branch cut from it ships both. So cut from a fresh
 * fetch of origin's default branch, and say so loudly when that is impossible.
 */
export function resolveBranchBase(gitRoot: string, timeoutMs: number): Promise<BranchBase> {
  const pending = inflightBases.get(gitRoot)
  if (pending !== undefined) return pending
  const resolving = resolveBranchBaseNow(gitRoot, timeoutMs).finally(() => inflightBases.delete(gitRoot))
  inflightBases.set(gitRoot, resolving)
  return resolving
}

async function resolveBranchBaseNow(gitRoot: string, timeoutMs: number): Promise<BranchBase> {
  const reason = await fetchDefaultTip(gitRoot, timeoutMs)
  if (typeof reason !== 'string') return reason
  const sha = (await gitOrNull(['rev-parse', 'HEAD'], gitRoot)) ?? 'HEAD'
  return {
    sha,
    ref: 'HEAD',
    warning:
      `worktree branched from the local HEAD at ${sha} because ${reason}; ` +
      'it may lag origin or carry unpushed commits',
  }
}

/** `warning` is set exactly when the base is a local HEAD, which no setup declaration is trusted from. */
const setupTarget = (gitRoot: string, worktree: string, base: BranchBase): SetupTarget => ({
  gitRoot,
  worktree,
  baseSha: base.sha,
  fetched: base.warning === undefined,
})

/** The tail of each repo's queue of `worktree add`s; it never rejects, so one failure does not jam the rest. */
const addQueues = new Map<string, Promise<unknown>>()

/**
 * CC-224: concurrent adds in one repo read each other's half-written
 * `.git/worktrees/<name>/commondir` and die, so they take turns per repo.
 */
function addWorktree(gitRoot: string, args: readonly string[], run: GitRunner = git): Promise<string> {
  const adding = (addQueues.get(gitRoot) ?? Promise.resolve()).then(() => run(args, gitRoot))
  const tail = adding.catch(() => undefined)
  addQueues.set(gitRoot, tail)
  void tail.then(() => addQueues.get(gitRoot) === tail && addQueues.delete(gitRoot))
  return adding
}

const addTarget = (args: readonly string[]): string | undefined => (args[2] === '-b' ? args[4] : args[2])

const CLEANUP_TIMEOUT_MS = 30_000
/** SIGTERM first so git can drop its lock files; SIGKILL follows for whatever ignores it. */
const TERM_GRACE_MS = 1_000

class AddTimedOut extends Error {}

const groupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}

const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal)
  } catch {
    // The group is already gone.
  }
}

async function reapGroup(pid: number): Promise<void> {
  signalGroup(pid, 'SIGKILL')
  for (let i = 0; i < 100 && groupAlive(pid); i++) await new Promise(r => setTimeout(r, 20))
}

/**
 * Run git in its own process group, so a timeout can kill the hooks and filters
 * it spawned and not only git itself. Settles only after the child has exited and
 * the group is reaped, so cleanup never races a process that can still write.
 */
function gitInGroup(args: readonly string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], { cwd, env: gitChildEnv(), detached: true })
    const pid = child.pid
    let out = ''
    let err = ''
    let timedOut = false
    child.stdout.on('data', chunk => (out += chunk))
    child.stderr.on('data', chunk => (err += chunk))
    const term = setTimeout(() => {
      timedOut = true
      if (pid !== undefined) signalGroup(pid, 'SIGTERM')
    }, timeoutMs)
    const kill = setTimeout(() => pid !== undefined && signalGroup(pid, 'SIGKILL'), timeoutMs + TERM_GRACE_MS)
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(term)
      clearTimeout(kill)
      void (pid === undefined ? Promise.resolve() : reapGroup(pid)).then(() => {
        if (timedOut) reject(new AddTimedOut())
        else if (code === 0) resolve(out.trim())
        else
          reject(
            Object.assign(new Error(err.trim() || `git exited with code ${code}`), { code, stderr: err }),
          )
      })
    })
  })
}

/**
 * A timed-out add can leave a half-written directory and a registration under
 * `.git/worktrees`. Only a directory the add itself created is removed: one that
 * existed beforehand belongs to someone else. The branch a `-b` add created is
 * kept, since it holds no commits and the next attach resets it.
 */
async function discardHalfCreated(gitRoot: string, args: readonly string[], created: boolean): Promise<void> {
  const target = addTarget(args)
  if (created && target !== undefined) {
    await gitOrNull(['worktree', 'remove', '--force', target], gitRoot, CLEANUP_TIMEOUT_MS)
    rmSync(target, { recursive: true, force: true })
  }
  await gitOrNull(['worktree', 'prune'], gitRoot, CLEANUP_TIMEOUT_MS)
}

/** The newest add per path; a late finisher only cleans up if no later add has taken the path since. */
const latestAdd = new Map<string, object>()

/** CC-239: one hung add (a hook, a filter) must not hold the repo's queue forever. */
function boundedAdd(run: GitRunner | undefined, timeoutMs: number): GitRunner {
  return async (args, cwd) => {
    const target = addTarget(args)
    const created = target !== undefined && !existsSync(target)
    const mine = {}
    if (target !== undefined) latestAdd.set(target, mine)
    const timedOut = new Error(`git worktree add in ${cwd} timed out after ${timeoutMs}ms and was killed`)
    try {
      return await (run === undefined
        ? gitInGroup(args, cwd, timeoutMs)
        : raceTimer(run(args, cwd), timeoutMs, () => cleanLate(cwd, args, created, mine)))
    } catch (err) {
      if (!(err instanceof AddTimedOut)) throw err
      await discardHalfCreated(cwd, args, created)
      throw timedOut
    }
  }
}

async function cleanLate(
  cwd: string,
  args: readonly string[],
  created: boolean,
  mine: object,
): Promise<void> {
  const target = addTarget(args)
  if (target === undefined || latestAdd.get(target) !== mine) return
  await discardHalfCreated(cwd, args, created)
}

async function raceTimer(
  add: Promise<string>,
  timeoutMs: number,
  onLate: () => Promise<void>,
): Promise<string> {
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AddTimedOut()), timeoutMs)
  })
  try {
    return await Promise.race([add, expired])
  } catch (err) {
    if (err instanceof AddTimedOut) void add.then(onLate, () => undefined)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** Hooks and settings live in gitignored .claude/, so a fresh worktree runs unhooked without this. */
function copyClaudeDir(gitRoot: string, worktreePath: string): void {
  const source = path.resolve(gitRoot, '.claude')
  const target = path.resolve(worktreePath, '.claude')
  if (existsSync(source) && !existsSync(target)) cpSync(source, target, { recursive: true })
}

interface AttachOptions {
  base: string
  force: boolean
  run?: GitRunner | undefined
}

async function resetTo(
  gitRoot: string,
  branch: string,
  worktreePath: string,
  opts: AttachOptions,
): Promise<void> {
  await gitOrNull(['worktree', 'remove', '--force', worktreePath], gitRoot)
  rmSync(worktreePath, { recursive: true, force: true })
  await gitOrNull(['branch', '-D', branch], gitRoot)
  await addWorktree(gitRoot, ['worktree', 'add', '-b', branch, worktreePath, opts.base], opts.run)
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
  opts: AttachOptions,
): Promise<boolean> {
  if ((await gitOrNull(['rev-parse', '--verify', branch], gitRoot)) === null) {
    await addWorktree(gitRoot, ['worktree', 'add', '-b', branch, worktreePath, opts.base], opts.run)
    copyClaudeDir(gitRoot, worktreePath)
    return false
  }

  if (opts.force) {
    await resetTo(gitRoot, branch, worktreePath, opts)
    copyClaudeDir(gitRoot, worktreePath)
    return false
  }

  const holder = await checkoutOf(gitRoot, branch)
  if (holder !== null || existsSync(worktreePath))
    throw new WorktreeInUseError(branch, holder ?? worktreePath)

  const safety = await inspectForRelease(gitRoot, worktreePath, branch, opts.base)
  if (safety.unmerged) await addWorktree(gitRoot, ['worktree', 'add', worktreePath, branch], opts.run)
  else await resetTo(gitRoot, branch, worktreePath, opts)

  copyClaudeDir(gitRoot, worktreePath)
  return safety.unmerged
}

/** Where a worktree this strategy created sat, read back from its `isolation_allocated` row. */
export interface WorktreeRecord {
  gitRoot: string
  worktree: string
  branch: string
}

/** How a re-attached worktree got its branch back. */
type BranchSource = 'local' | 'origin' | 'fresh'

/** Origin could not answer whether it holds the branch, so a fresh fork might discard real work. */
export class OriginUnreachableError extends Error {
  constructor(
    readonly branch: string,
    detail: string,
  ) {
    super(
      `cannot reach origin to look for branch ${branch} (${detail}); it may still hold the agent's work, ` +
        'so the worktree was not re-created. Fix the remote and resume again.',
    )
    this.name = 'OriginUnreachableError'
  }
}

/** `ls-remote --exit-code` exits 2 only when the ref is absent; anything else is a failed lookup. */
async function originHasBranch(gitRoot: string, branch: string, timeoutMs: number): Promise<boolean> {
  try {
    await git(['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${branch}`], gitRoot, timeoutMs)
    return true
  } catch (err) {
    if ((err as { code?: unknown }).code === 2) return false
    throw new OriginUnreachableError(branch, firstLine(err))
  }
}

const firstLine = (err: unknown): string =>
  String((err as { stderr?: unknown }).stderr || (err as Error).message)
    .trim()
    .split('\n')[0] ?? 'unknown error'

/** Local first, since it may hold commits origin never saw; a squash merge deletes both. */
async function branchSource(gitRoot: string, branch: string, timeoutMs: number): Promise<BranchSource> {
  if ((await gitOrNull(['rev-parse', '--verify', branch], gitRoot)) !== null) return 'local'
  if ((await gitOrNull(['remote', 'get-url', 'origin'], gitRoot)) === null) return 'fresh'
  if (!(await originHasBranch(gitRoot, branch, timeoutMs))) return 'fresh'
  if ((await fetchTip(gitRoot, branch, timeoutMs)) === null)
    throw new OriginUnreachableError(branch, 'origin lists it but fetching it failed')
  return 'origin'
}

function addArgs(record: WorktreeRecord, source: BranchSource, base: string): string[] {
  const { worktree, branch } = record
  if (source === 'local') return ['worktree', 'add', worktree, branch]
  return ['worktree', 'add', '-b', branch, worktree, source === 'origin' ? `origin/${branch}` : base]
}

/** A concurrent re-attach of the same record loses the race here; say so rather than pass git's text on. */
async function addForSource(
  record: WorktreeRecord,
  source: BranchSource,
  base: string,
  run?: GitRunner,
): Promise<void> {
  try {
    await addWorktree(record.gitRoot, addArgs(record, source, base), run)
  } catch (err) {
    const holder = await checkoutOf(record.gitRoot, record.branch)
    if (holder !== null || existsSync(record.worktree))
      throw new WorktreeInUseError(record.branch, holder ?? record.worktree)
    throw err
  }
}

function reattachWarnings(record: WorktreeRecord, source: BranchSource, base: BranchBase): string[] {
  const inherited = base.warning === undefined ? [] : [base.warning]
  if (source !== 'fresh') return inherited
  const fresh =
    `branch ${record.branch} no longer exists locally or on origin (a squash merge deletes it), so ` +
    `${record.worktree} was re-created on a fresh ${record.branch} from ${base.ref} ${base.sha}; ` +
    'commits the conversation mentions may be merged or gone'
  return [fresh, ...inherited]
}

/** The record comes from the event log, so it may only name a tree under this repository's worktree base. */
function checkRecordPlacement(record: WorktreeRecord, basePath: string): void {
  const base = path.resolve(record.gitRoot, basePath) + path.sep
  if (!path.resolve(record.worktree).startsWith(base))
    throw new Error(`recorded worktree ${record.worktree} is not under ${base}; not re-created`)
}

/**
 * CC-140: put a removed worktree back at its recorded path, under the spawn's budget.
 *
 * `claude --resume` finds a transcript only under the project dir of the cwd it
 * starts in, and that dir is derived from the worktree path, so the path must be
 * the original one. Every file path in the conversation points there too.
 */
export async function reattachWorktree(
  record: WorktreeRecord,
  opts: WorktreeOptions = {},
): Promise<Allocation> {
  const { gitRoot, worktree, branch } = record
  const basePath = opts.basePath ?? DEFAULT_BASE_PATH
  checkRecordPlacement(record, basePath)
  if (existsSync(worktree)) throw new WorktreeInUseError(branch, worktree)
  await pruneStaleWorktrees(gitRoot)
  const allocated = await allocatedPaths(gitRoot, basePath)
  const budget = opts.budget ?? resolveWorktreeBudget(DEFAULT_WORKTREE_BUDGET)
  if (allocated.length >= budget) throw new WorktreeBudgetExhaustedError(allocated.length, budget)
  const holder = await checkoutOf(gitRoot, branch)
  if (holder !== null) throw new WorktreeInUseError(branch, holder)

  const timeoutMs = opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  const base = await resolveBranchBase(gitRoot, timeoutMs)
  const source = await branchSource(gitRoot, branch, timeoutMs)
  await addForSource(
    record,
    source,
    base.sha,
    boundedAdd(opts.runWorktreeAdd, opts.addTimeoutMs ?? WORKTREE_ADD_TIMEOUT_MS),
  )
  copyClaudeDir(gitRoot, worktree)
  const warnings = [
    ...reattachWarnings(record, source, base),
    ...(await runWorktreeSetup(setupTarget(gitRoot, worktree, base), opts.runSetup)),
  ]
  return {
    cwd: worktree,
    note: `Your worktree at ${worktree} had been removed and was re-created on branch ${branch}. Commit your work there; nothing outside it is yours to change.`,
    ref: { branch, worktree, gitRoot, base: base.sha, base_ref: base.ref, reattached: source },
    ...(warnings.length === 0 ? {} : { warnings }),
  }
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
  const budgetNow = (): number => opts.budget ?? resolveWorktreeBudget(DEFAULT_WORKTREE_BUDGET)

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
      const base = await resolveBranchBase(gitRoot, opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS)
      const reused = await attachWorktree(gitRoot, branch, worktreePath, {
        base: base.sha,
        force: ctx.forceReset === true,
        run: boundedAdd(opts.runWorktreeAdd, opts.addTimeoutMs ?? WORKTREE_ADD_TIMEOUT_MS),
      })
      const warnings = [
        ...(base.warning === undefined ? [] : [base.warning]),
        ...(await runWorktreeSetup(setupTarget(gitRoot, worktreePath, base), opts.runSetup)),
      ]

      const carried = reused ? ' It already carries commits from an earlier run under this name.' : ''
      return {
        cwd: worktreePath,
        note: `You are on branch ${branch} in an isolated worktree at ${worktreePath}.${carried} Commit your work there; nothing outside it is yours to change.`,
        ref: {
          branch,
          worktree: worktreePath,
          gitRoot,
          base: base.sha,
          base_ref: base.ref,
          ...(reused ? { reused: 'true' } : {}),
        },
        ...(warnings.length === 0 ? {} : { warnings }),
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
