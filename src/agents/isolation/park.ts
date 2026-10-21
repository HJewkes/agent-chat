import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import type { AgentEventRow } from '../../broker/event-store.js'
import { gitChildEnv } from '../../git.js'
import type { AgentIdentity } from '../../protocol.js'
import { canonicalPath, isAtOrUnder } from '../spawn-cwd.js'
import type { MergedPrReader } from './merged-pr.js'
import { occupantOf } from './sweep.js'
import { unsavedWork } from './unsaved-work.js'
import { fetchDefaultTip, type WorktreeRecord } from '@titan-design/worktree'

/**
 * CC-282: park a finished agent's worktree. The tree is removed and the branch
 * kept, so `agent resume` re-creates it at the same path through `goneWorktree`
 * (CC-140). Parking never deletes a branch: in a repo with no remote the local
 * branch is the only copy of the work.
 */

const execFileAsync = promisify(execFile)

/** A process whose working directory is inside a tree. */
export interface CwdProcess {
  pid: number
  cwd: string
}

/** Lists every process's cwd; throws when it cannot, which parking treats as a refusal. */
export type CwdLister = () => Promise<CwdProcess[]>

/** Runs `lsof`; rejects like `execFile` does, with `code` and `stdout` on a nonzero exit. */
export type LsofRunner = () => Promise<{ stdout: string }>

const runLsof: LsofRunner = () =>
  execFileAsync('lsof', ['-a', '-d', 'cwd', '-Fpn'], { encoding: 'utf8', maxBuffer: 64 << 20 })

function parseCwds(stdout: string): CwdProcess[] | undefined {
  const found: CwdProcess[] = []
  let pid = 0
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n') && pid > 0) found.push({ pid, cwd: line.slice(1) })
  }
  return found.length > 0 ? found : undefined
}

/**
 * `lsof -Fpn` prints `p<pid>` then `n<path>` per process. It exits 1 with no output when nothing
 * matches, and also when warnings accompany partial output, which still lists real processes.
 */
export const lsofCwdsWith =
  (run: LsofRunner): CwdLister =>
  async () => {
    const { stdout } = await run().catch((err: { code?: unknown; stdout?: string }) => {
      if (err.code === 1 && !err.stdout) return { stdout: '' }
      if (err.code === 1 && err.stdout && parseCwds(err.stdout)) return { stdout: err.stdout }
      throw err
    })
    return parseCwds(stdout) ?? []
  }

export const lsofCwds: CwdLister = lsofCwdsWith(runLsof)

/** A detached agent's process may have outlived a broker restart, so refuse while anything still sits in its tree. */
async function occupiedByProcess(tree: string, list: CwdLister): Promise<string | undefined> {
  let procs: CwdProcess[]
  try {
    procs = await list()
  } catch (err) {
    return `could not check for processes running in ${tree} (${(err as Error).message.split('\n')[0]}); not parked`
  }
  const root = canonicalPath(tree)
  const inside = procs.find(p => isAtOrUnder(canonicalPath(p.cwd), root))
  return inside && `process ${inside.pid} has its working directory in ${tree}; not parked while it runs`
}

/** The worktree an agent's newest `isolation_allocated` row records, and whether it was adopted rather than created. */
export interface ParkTarget extends WorktreeRecord {
  assigned: boolean
}

export function allocatedWorktree(rows: readonly AgentEventRow[], agentId: string): ParkTarget | undefined {
  const meta = rows.findLast(row => row.kind === 'isolation_allocated' && row.ref === agentId)?.meta
  if (meta?.strategy !== 'worktree') return undefined
  const { gitRoot, worktree, branch } = meta
  if (!gitRoot || !worktree || !branch) return undefined
  return { gitRoot, worktree, branch, assigned: meta.assigned === 'true' }
}

/** Parkable: exited, or detached with no process this broker tracks (the state after a broker restart). */
function stateBlocker(agent: AgentIdentity, tracked: boolean): string | undefined {
  const finished = agent.state === 'exited' || agent.state === 'detached'
  if (finished && !tracked) return undefined
  const state = agent.state === 'exited' ? 'still tracked as running' : agent.state
  return `${agent.name} is ${state}; park takes only an agent whose process has exited or that this broker no longer tracks`
}

/** Any other identity that is not retired and works in the tree, live or not, since it could be resumed there. */
function tenancyBlocker(
  agent: AgentIdentity,
  tree: string,
  roster: readonly AgentIdentity[],
): string | undefined {
  const others = roster.filter(a => a.agentId !== agent.agentId)
  const occupant = occupantOf(tree, others)
  if (occupant) return `${occupant.name} is ${occupant.state} in ${tree}; not parked`
  const tenants = others.filter(a => a.cwd !== '' && isAtOrUnder(canonicalPath(a.cwd), canonicalPath(tree)))
  if (tenants.length === 0) return undefined
  const who = tenants.map(a => a.name).join(', ')
  return `${who} (not retired) also works in ${tree}, so parking ${agent.name} would pull it from under them; retire ${who} first`
}

/** Why `agent` cannot be parked, or undefined when it can. `tracked` means this broker still watches its process. */
export function parkBlocker(
  agent: AgentIdentity,
  tracked: boolean,
  target: ParkTarget | undefined,
  roster: readonly AgentIdentity[],
): string | undefined {
  const byState = stateBlocker(agent, tracked)
  if (byState) return byState
  if (target === undefined) return `${agent.name} holds no worktree agent-chat allocated`
  if (!existsSync(target.worktree)) return `${target.worktree} is not on disk; nothing to park`
  const byTenant = tenancyBlocker(agent, target.worktree, roster)
  if (byTenant) return byTenant
  if (target.assigned)
    return `${target.worktree} was adopted by ${agent.name}, not allocated, so resume could not re-create it; park its owner instead`
  return undefined
}

async function git(args: readonly string[], cwd: string, timeout = 0): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], {
    cwd,
    encoding: 'utf8',
    env: gitChildEnv(),
    timeout,
  })
  return stdout.trim()
}

async function gitOrNull(args: readonly string[], cwd: string, timeout = 0): Promise<string | null> {
  return git(args, cwd, timeout).catch(() => null)
}

const DEFAULT_FETCH_MS = 30_000

/** A never-pushed branch whose HEAD is already in origin's default branch (a reviewer tree) holds nothing to lose. */
async function headOnDefaultBranch(worktree: string): Promise<boolean> {
  const tip = await fetchDefaultTip(worktree, DEFAULT_FETCH_MS)
  if (typeof tip === 'string') return false
  return (await gitOrNull(['merge-base', '--is-ancestor', 'HEAD', tip.sha], worktree)) !== null
}

/**
 * CC-1039: the first branch origin lists right now whose tip contains HEAD, so commits pushed under another
 * name (a PR head) count as pushed. It asks origin rather than reading tracking refs, so a branch deleted or
 * force-pushed on origin does not count; a tip whose object is not local fails closed.
 */
async function containingRemoteHead(worktree: string): Promise<string | undefined> {
  const listed = await gitOrNull(['ls-remote', '--heads', 'origin'], worktree, DEFAULT_FETCH_MS)
  for (const line of (listed ?? '').split('\n')) {
    const [sha, ref] = line.split('\t')
    if (!sha || !ref?.startsWith('refs/heads/')) continue
    if ((await gitOrNull(['merge-base', '--is-ancestor', 'HEAD', sha], worktree)) !== null)
      return ref.slice('refs/heads/'.length)
  }
  return undefined
}

/**
 * CC-1064: the merged PR on `branch` whose head commit contains HEAD, for a squash merge whose head branch
 * origin deleted. A reader rejection, an ancestry miss or a PR head object not local all fail closed.
 */
async function mergedPrHolding(
  target: ParkTarget,
  branch: string,
  read: MergedPrReader | undefined,
): Promise<number | undefined> {
  if (read === undefined) return undefined
  const prs = await read(target.gitRoot, branch).catch(() => [])
  for (const pr of prs) {
    if ((await gitOrNull(['merge-base', '--is-ancestor', 'HEAD', pr.headSha], target.worktree)) !== null)
      return pr.number
  }
  return undefined
}

/** Why `origin/<branch>` does not hold HEAD, or undefined when it does. */
async function behindTracked(worktree: string, branch: string): Promise<string | undefined> {
  if ((await gitOrNull(['rev-parse', '--verify', '--quiet', `origin/${branch}`], worktree)) === null)
    return (await headOnDefaultBranch(worktree)) ? undefined : `${branch} is not on origin; push it first`
  const ahead = await gitOrNull(['rev-list', `origin/${branch}..HEAD`], worktree)
  if (ahead === null) return `could not compare ${worktree} with origin/${branch}`
  const count = ahead.split('\n').filter(Boolean).length
  return count === 0 ? undefined : `${count} commit(s) in ${worktree} are not on origin/${branch}; push first`
}

type Pushed = { refusal: string } | { containedIn?: string; mergedPr?: number }

/**
 * With an origin, HEAD must be on it, under its own name or any other, or in a merged PR's head; without
 * one, the kept local branch is the copy.
 */
async function unpushed(
  target: ParkTarget,
  branch: string,
  read: MergedPrReader | undefined,
): Promise<Pushed> {
  const { worktree } = target
  if ((await gitOrNull(['remote', 'get-url', 'origin'], worktree)) === null) return {}
  const refusal = await behindTracked(worktree, branch)
  if (refusal === undefined) return {}
  const containedIn = await containingRemoteHead(worktree)
  if (containedIn !== undefined) return { containedIn }
  const mergedPr = await mergedPrHolding(target, branch, read)
  return mergedPr === undefined ? { refusal } : { mergedPr }
}

type Kept = { branch: string; containedIn?: string; mergedPr?: number }

type HeadBranch = Kept | { refusal: string }

/**
 * The branch the tree's commits live on, or the reason it has none to keep. A commit on a detached HEAD
 * would be unreachable once the tree is gone. A successor or adopted tree sits on the PR branch rather than
 * the allocated one; that local branch is kept too, so it parks when origin has it or has HEAD under another
 * name, and `unpushed` then holds it to nothing ahead.
 */
async function headBranch(target: ParkTarget, read: MergedPrReader | undefined): Promise<HeadBranch> {
  const head = await gitOrNull(['symbolic-ref', '--quiet', '--short', 'HEAD'], target.worktree)
  if (head === target.branch) return { branch: head }
  const onOrigin =
    head !== null &&
    (await gitOrNull(['rev-parse', '--verify', '--quiet', `origin/${head}`], target.worktree)) !== null
  if (head !== null && onOrigin) return { branch: head }
  const containedIn = head === null ? undefined : await containingRemoteHead(target.worktree)
  if (head !== null && containedIn !== undefined) return { branch: head, containedIn }
  const mergedPr = head === null ? undefined : await mergedPrHolding(target, head, read)
  if (head !== null && mergedPr !== undefined) return { branch: head, mergedPr }
  const where = head === null ? 'detached' : `on ${head}`
  return {
    refusal: `HEAD in ${target.worktree} is ${where}, not on ${target.branch}; check out ${target.branch} first`,
  }
}

/** The local branch to keep, and the origin branch holding HEAD when that is another name, or why nothing parks. */
async function keepable(
  target: ParkTarget,
  listCwds: CwdLister | undefined,
  read: MergedPrReader | undefined,
): Promise<Kept | { reason: string }> {
  const occupied = listCwds && (await occupiedByProcess(target.worktree, listCwds))
  if (occupied) return { reason: occupied }
  const head = await headBranch(target, read)
  if ('refusal' in head) return { reason: head.refusal }
  const dirty = await unsavedWork(target.worktree, 'park')
  if (dirty) return { reason: dirty.detail }
  if (head.containedIn !== undefined || head.mergedPr !== undefined) return head
  const pushed = await unpushed(target, head.branch, read)
  if ('refusal' in pushed) return { reason: pushed.refusal }
  return { branch: head.branch, ...pushed }
}

/**
 * Refuse a tree that would lose anything; otherwise remove it without --force and keep the branch.
 * `recheck` runs after the git checks and right before the removal, so a spawn or resume that
 * started meanwhile is caught. Returns the parked head, `containedIn` when origin holds it only
 * under another branch name, and `mergedPr` when only a merged PR's head holds it.
 */
export async function parkWorktree(
  target: ParkTarget,
  recheck: () => string | undefined,
  /** Set for an untracked detached agent: the lister that finds a process still in the tree. */
  listCwds?: CwdLister,
  /** Set by the broker: GitHub's merged PRs, for a squash-merged branch origin deleted. */
  mergedPr?: MergedPrReader,
): Promise<({ ok: true; head: string } & Kept) | { ok: false; reason: string }> {
  const kept = await keepable(target, listCwds, mergedPr)
  if ('reason' in kept) return { ok: false, reason: kept.reason }
  const parkedHead = await git(['rev-parse', 'HEAD'], target.worktree)
  const late = recheck()
  if (late) return { ok: false, reason: late }
  try {
    await git(['worktree', 'remove', target.worktree], target.gitRoot)
  } catch (err) {
    const detail = String((err as { stderr?: unknown }).stderr || (err as Error).message).trim()
    return { ok: false, reason: `git would not remove ${target.worktree}: ${detail.split('\n')[0]}` }
  }
  return { ok: true, head: parkedHead, ...kept }
}
