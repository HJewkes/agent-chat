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

/** Only an exited agent is parkable: a detached one may still be running in the tree, reconnecting. */
function stateBlocker(agent: AgentIdentity, tracked: boolean): string | undefined {
  if (agent.state === 'exited' && !tracked) return undefined
  const state = agent.state === 'exited' ? 'still tracked as running' : agent.state
  return `${agent.name} is ${state}; park takes only an agent whose process has exited`
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

/** `.claude` only at the top, since re-attach copies it from the repository root. */
const isRegenerable = (entry: string): boolean => {
  const segments = entry.split('/').filter(Boolean)
  return segments[0] === '.claude' || segments.some(segment => REGENERABLE_DIRS.includes(segment))
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
  const kept = ignored.split('\n').filter(entry => entry !== '' && !isRegenerable(entry))
  if (kept.length === 0) return undefined
  return (
    `ignored files in ${worktree} would be deleted (${kept.slice(0, 3).join(', ')}); ` +
    `park removes only ignored ${REGENERABLE_DIRS.join(', ')} and a top-level .claude`
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
): Promise<{ ok: true; head: string } | { ok: false; reason: string }> {
  const refusal = (await offBranch(target)) ?? (await unsaved(target.worktree)) ?? (await unpushed(target))
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
