import { existsSync } from 'node:fs'
import type { AgentEventRow } from '../../broker/event-store.js'
import { runGit, type GitRunner } from '../../git.js'
import type { AgentIdentity, RetirePlanEntry, RetireResult } from '../../protocol.js'
import { canonicalPath, isAtOrUnder } from '../spawn-cwd.js'
import { allocatedWorktree, type ParkTarget } from './park.js'
import { shepherdSkip, type ShepherdSkipPort } from './shepherd-skip.js'
import { isLive } from './sweep.js'

/**
 * CC-323: the skip rules for `agent retire --finished`. Every rule errs towards
 * skipping: a wrong skip costs a line of output, a wrong retire can lose work.
 * The retire itself still goes through `Supervisor.retire`, so its refusals apply too.
 */

export interface RetireScope {
  spawner?: string
  prefix?: string
}

/** CC-408: who holds a name's live connection, relative to one row. */
export type NamePresence = 'self' | 'other' | 'none'

/** What the bulk form reads from, and retires through, the supervisor. */
export interface FinishedRetirePort {
  roster(): AgentIdentity[]
  events(): readonly AgentEventRow[]
  /** This broker still watches the agent's process. */
  tracked(agentId: string): boolean
  parking(agentId: string): boolean
  current(agentId: string): AgentIdentity | undefined
  /** CC-408: liveness from the connected process, since a registry row can say `exited` while it runs. */
  presence(agent: AgentIdentity): NamePresence
  /** CC-408: by id, so a stale row never resolves to the newest holder of its name. */
  retire(agentId: string): Promise<{ ok: boolean; reason?: string }>
  git?: GitRunner
  /** CC-904: the open-PR and Shepherd reads; the broker always passes them. */
  skip?: ShepherdSkipPort
}

export interface FinishedRetireOutcome {
  ok: boolean
  reason?: string
  plan: RetirePlanEntry[]
  results: RetireResult[]
}

export const SCOPE_REQUIRED =
  'name --spawner or --prefix; --finished alone would sweep every agent on the machine'

interface Planned {
  agentId: string
  entry: RetirePlanEntry
}

/** Plan every in-scope agent, then retire the planned ones one at a time; one failure never stops the rest. */
export async function retireFinished(
  port: FinishedRetirePort,
  req: RetireScope & { dryRun?: boolean; caller?: string },
): Promise<FinishedRetireOutcome> {
  const malformed = malformedRequest(req)
  if (malformed) return { ok: false, reason: malformed, plan: [], results: [] }
  if (!req.spawner?.trim() && !req.prefix?.trim())
    return { ok: false, reason: SCOPE_REQUIRED, plan: [], results: [] }
  const planned = await planFinished(port, req)
  const plan = planned.map(p => p.entry)
  if (req.dryRun === true) return { ok: true, plan, results: [] }
  const results: RetireResult[] = []
  for (const { agentId, entry } of planned)
    if (entry.action === 'retire') results.push(await retireOne(port, agentId, entry.name))
  return { ok: results.every(r => r.ok), plan, results }
}

/** The frame arrives from any socket client, so its field types are unchecked until here. */
function malformedRequest(req: RetireScope & { dryRun?: unknown }): string | undefined {
  const field = (value: unknown, type: string): boolean => value === undefined || typeof value === type
  if (!field(req.spawner, 'string')) return 'spawner must be a string'
  if (!field(req.prefix, 'string')) return 'prefix must be a string'
  if (!field(req.dryRun, 'boolean')) return 'dryRun must be a boolean'
  return undefined
}

async function planFinished(
  port: FinishedRetirePort,
  scope: RetireScope & { caller?: string },
): Promise<Planned[]> {
  const roster = port.roster()
  const events = port.events()
  const callers = new Set([scope.caller, scope.spawner].filter((n): n is string => Boolean(n?.trim())))
  const planned: Planned[] = []
  for (const agent of roster.filter(a => inScope(a, scope))) {
    const reason = callers.has(agent.name)
      ? `${agent.name} is the caller itself, not an agent it spawned`
      : await finishedBlocker(port, agent, roster, events)
    const base: Omit<RetirePlanEntry, 'action'> = { name: agent.name, ...duplicateOf(agent, roster) }
    const entry: RetirePlanEntry =
      reason === undefined ? { ...base, action: 'retire' } : { ...base, action: 'skip', reason }
    planned.push({ agentId: agent.agentId, entry })
  }
  return planned
}

/** Teleport successors keep their predecessor's name, so a name alone cannot say which row the plan means. */
function duplicateOf(
  agent: AgentIdentity,
  roster: readonly AgentIdentity[],
): Pick<RetirePlanEntry, 'agentId' | 'duplicate'> {
  const twins = roster.filter(a => a.name === agent.name && a.agentId !== agent.agentId)
  return twins.length === 0 ? {} : { agentId: agent.agentId, duplicate: true }
}

async function finishedBlocker(
  port: FinishedRetirePort,
  agent: AgentIdentity,
  roster: readonly AgentIdentity[],
  events: readonly AgentEventRow[],
): Promise<string | undefined> {
  const byState = liveBlocker(agent, port.tracked(agent.agentId)) ?? connectedBlocker(port, agent)
  if (byState) return byState
  if (agent.origin !== 'spawned') return 'not spawned by agent-chat; retire it by name'
  if (port.parking(agent.agentId)) return 'being parked'
  const target = allocatedWorktree(events, agent.agentId)
  const byAdopter = adopterBlocker(agent, target, roster)
  if (byAdopter) return byAdopter
  const byShepherd = port.skip && (await shepherdSkip(port.skip, agent, target))
  if (byShepherd) return byShepherd
  if (target === undefined) return undefined
  return workBlocker(target, port.git).catch(
    (err: Error) => `could not read ${target.worktree}: ${err.message}`,
  )
}

/** The git checks await, so the agent may have been resumed meanwhile; check again right before retiring. */
async function retireOne(port: FinishedRetirePort, agentId: string, name: string): Promise<RetireResult> {
  const now = port.current(agentId)
  if (now?.name !== name) return { name, ok: false, reason: 'no longer the agent the plan named' }
  const late = liveBlocker(now, port.tracked(agentId)) ?? connectedBlocker(port, now)
  if (late) return { name, ok: false, reason: `became ${late} after the plan` }
  try {
    const res = await port.retire(agentId)
    return { name, ok: res.ok, ...(res.reason === undefined ? {} : { reason: res.reason }) }
  } catch (err) {
    return { name, ok: false, reason: (err as Error).message }
  }
}

/** A scope with neither field would sweep every agent on the machine, so it matches nothing. */
export function inScope(agent: AgentIdentity, scope: RetireScope): boolean {
  if (!scope.spawner?.trim() && !scope.prefix?.trim()) return false
  if (scope.spawner !== undefined && agent.spawnedBy !== scope.spawner) return false
  return scope.prefix === undefined || agent.name.startsWith(scope.prefix)
}

/** `tracked` means this broker still watches the agent's process, which a detached agent can have. */
export function liveBlocker(agent: AgentIdentity, tracked: boolean): string | undefined {
  if (isLive(agent.state)) return agent.state
  if (tracked) return `${agent.state}, but its process is still running`
  return undefined
}

function connectedBlocker(port: FinishedRetirePort, agent: AgentIdentity): string | undefined {
  return port.presence(agent) === 'self' ? `${agent.state}, but its process is still connected` : undefined
}

/** Any other identity that is not retired and works in the tree, the test `retire` itself applies (CC-141). */
export function adopterBlocker(
  agent: AgentIdentity,
  target: ParkTarget | undefined,
  roster: readonly AgentIdentity[],
): string | undefined {
  if (target === undefined || target.assigned) return undefined
  const tree = canonicalPath(target.worktree)
  const tenants = roster
    .filter(a => a.agentId !== agent.agentId && a.cwd !== '' && isAtOrUnder(canonicalPath(a.cwd), tree))
    .map(a => a.name)
  if (tenants.length === 0) return undefined
  return `${tenants.join(', ')} (not retired) still works in its worktree`
}

/** Uncommitted or unpushed work in the agent's tree, or in its branch when the tree is gone. */
export async function workBlocker(target: ParkTarget, git: GitRunner = runGit): Promise<string | undefined> {
  if (existsSync(target.worktree))
    return (await uncommitted(target.worktree, git)) ?? (await unpushed(target.worktree, 'HEAD', git))
  if (!existsSync(target.gitRoot)) return `neither ${target.worktree} nor ${target.gitRoot} is on disk`
  const branch = await git(
    ['rev-parse', '--verify', '--quiet', `refs/heads/${target.branch}`],
    target.gitRoot,
  )
  if (branch === null) return undefined
  return unpushed(target.gitRoot, target.branch, git)
}

/** `-uall` so `status.showUntrackedFiles=no` cannot hide an untracked file. */
async function uncommitted(tree: string, git: GitRunner): Promise<string | undefined> {
  const status = await git(['status', '--porcelain', '-uall'], tree)
  if (status === null) return `could not read git status in ${tree}`
  return status === '' ? undefined : `uncommitted changes in ${tree}`
}

async function unpushed(dir: string, ref: string, git: GitRunner): Promise<string | undefined> {
  const base = (await upstreamOf(dir, ref, git)) ?? (await defaultBranch(dir, git))
  if (base === undefined) return `${ref} in ${dir} has no upstream and no default branch to compare with`
  const ahead = await git(['rev-list', `${base.ref}..${ref}`], dir)
  if (ahead === null) return `could not compare ${ref} in ${dir} with ${base.ref}`
  const count = ahead.split('\n').filter(Boolean).length
  return count === 0 ? undefined : `${count} commit(s) in ${dir} are not on ${base.label}`
}

interface Base {
  ref: string
  label: string
}

/** The configured upstream, else `origin/<branch>`: a branch pushed without `-u` is still pushed. */
async function upstreamOf(dir: string, ref: string, git: GitRunner): Promise<Base | undefined> {
  const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${ref}@{u}`], dir)
  if (upstream !== null) return { ref: upstream, label: `upstream ${upstream}` }
  const branch = ref === 'HEAD' ? await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], dir) : ref
  if (branch === null) return undefined
  const remote = await git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], dir)
  return remote === null ? undefined : { ref: `origin/${branch}`, label: `origin/${branch}` }
}

async function defaultBranch(dir: string, git: GitRunner): Promise<Base | undefined> {
  for (const candidate of ['origin/HEAD', 'main', 'master']) {
    if ((await git(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], dir)) !== null)
      return { ref: candidate, label: `the default branch ${candidate} (no upstream)` }
  }
  return undefined
}
