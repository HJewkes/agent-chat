import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import type { AgentEventRow } from '../../broker/event-store.js'
import { gitChildEnv } from '../../git.js'
import type { AgentIdentity } from '../../protocol.js'
import { canonicalPath, isAtOrUnder } from '../spawn-cwd.js'
import { occupantOf } from './sweep.js'
import type { WorktreeRecord } from './worktree.js'

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

async function git(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd, encoding: 'utf8', env: gitChildEnv() })
  return stdout.trim()
}

async function gitOrNull(args: readonly string[], cwd: string): Promise<string | null> {
  return git(args, cwd).catch(() => null)
}

/** With an origin, the branch must be on it with nothing ahead; without one, the kept local branch is the copy. */
async function unpushed(target: ParkTarget): Promise<string | undefined> {
  const { worktree, branch } = target
  if ((await gitOrNull(['remote', 'get-url', 'origin'], worktree)) === null) return undefined
  if ((await gitOrNull(['rev-parse', '--verify', '--quiet', `origin/${branch}`], worktree)) === null)
    return `${branch} is not on origin; push it first`
  const ahead = await gitOrNull(['rev-list', `origin/${branch}..HEAD`], worktree)
  if (ahead === null) return `could not compare ${worktree} with origin/${branch}`
  const count = ahead.split('\n').filter(Boolean).length
  return count === 0 ? undefined : `${count} commit(s) in ${worktree} are not on origin/${branch}; push first`
}

/** A commit on a detached HEAD or another branch would be unreachable once the tree is gone, since only `branch` is kept. */
async function offBranch(target: ParkTarget): Promise<string | undefined> {
  const head = await gitOrNull(['symbolic-ref', '--quiet', '--short', 'HEAD'], target.worktree)
  if (head === target.branch) return undefined
  const where = head === null ? 'detached' : `on ${head}`
  return `HEAD in ${target.worktree} is ${where}, not on ${target.branch}; check out ${target.branch} first`
}

/** Ignored paths `git worktree remove` would delete that a build or agent-chat's own re-attach puts back. */
const REGENERABLE_DIRS = ['node_modules', 'dist', 'coverage', '.turbo']

/** `.claude` only at the top, since re-attach copies it from the repository root. `.tsbuildinfo` applies to files only: a directory so named may hold anything. */
const isRegenerable = (entry: string): boolean => {
  const segments = entry.split('/').filter(Boolean)
  if (!entry.endsWith('/') && segments.at(-1)?.endsWith('.tsbuildinfo')) return true
  return segments[0] === '.claude' || segments.some(segment => REGENERABLE_DIRS.includes(segment))
}

/** `--directory` collapses a wholly ignored directory into one entry; list its files so a nested build output is judged alone. */
async function expandDirectory(worktree: string, entry: string): Promise<string[]> {
  if (!entry.endsWith('/')) return [entry]
  const files = await gitOrNull(
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--', entry],
    worktree,
  )
  return files === null ? [entry] : files.split('\n').filter(Boolean)
}

/** `-uall` so `status.showUntrackedFiles=no` cannot hide an untracked file the removal would take. */
async function unsaved(worktree: string): Promise<string | undefined> {
  const status = await gitOrNull(['status', '--porcelain', '-uall'], worktree)
  if (status === null) return `could not read git status in ${worktree}`
  if (status !== '') return `uncommitted or untracked changes in ${worktree}`
  const ignored = await gitOrNull(
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
    worktree,
  )
  if (ignored === null) return `could not list ignored files in ${worktree}`
  const entries = ignored.split('\n').filter(entry => entry !== '' && !isRegenerable(entry))
  const kept = (await Promise.all(entries.map(entry => expandDirectory(worktree, entry)))).flat()
  const unregenerable = kept.filter(entry => !isRegenerable(entry))
  if (unregenerable.length === 0) return undefined
  return (
    `ignored files in ${worktree} would be deleted (${unregenerable.slice(0, 3).join(', ')}); ` +
    `park removes only ignored ${REGENERABLE_DIRS.join(', ')}, *.tsbuildinfo and a top-level .claude`
  )
}

/**
 * Refuse a tree that would lose anything; otherwise remove it without --force and keep the branch.
 * `recheck` runs after the git checks and right before the removal, so a spawn or resume that
 * started meanwhile is caught. Returns the parked head.
 */
export async function parkWorktree(
  target: ParkTarget,
  recheck: () => string | undefined,
  /** Set for an untracked detached agent: the lister that finds a process still in the tree. */
  listCwds?: CwdLister,
): Promise<{ ok: true; head: string } | { ok: false; reason: string }> {
  const refusal =
    (listCwds && (await occupiedByProcess(target.worktree, listCwds))) ??
    (await offBranch(target)) ??
    (await unsaved(target.worktree)) ??
    (await unpushed(target))
  if (refusal) return { ok: false, reason: refusal }
  const head = await git(['rev-parse', 'HEAD'], target.worktree)
  const late = recheck()
  if (late) return { ok: false, reason: late }
  try {
    await git(['worktree', 'remove', target.worktree], target.gitRoot)
  } catch (err) {
    const detail = String((err as { stderr?: unknown }).stderr || (err as Error).message).trim()
    return { ok: false, reason: `git would not remove ${target.worktree}: ${detail.split('\n')[0]}` }
  }
  return { ok: true, head }
}
