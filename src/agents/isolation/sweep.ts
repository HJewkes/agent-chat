import fs from 'node:fs'
import path from 'node:path'
import { agentsDir } from '../../paths.js'
import { readRuntimeState, runtimeStatePath } from '../launch-files.js'
import { BRANCH_PREFIX, inspectForRelease, RECLAIM_GRACE_MS, worktreeStrategy } from './worktree.js'
import type { Allocation } from './index.js'
import type { AgentIdentity } from '../../protocol.js'

/**
 * Find the worktrees agent-chat is holding, and say which ones nobody is using.
 *
 * WHY THIS EXISTS SEPARATELY FROM RELEASE (CC-80). Release is driven by retire,
 * and retire is driven by a person deciding they are done. The leak is the case
 * where nobody ever decides: an agent exits, is never retired, and holds its
 * worktree and its branch indefinitely. `RECLAIM_GRACE_MS` already answers "how
 * long until this is reclaimable" — nothing was ever asking the question.
 *
 * TWO SOURCES, because neither alone is complete:
 *
 * - `runtime.json` per agent, which is exactly the set of allocations agent-chat
 *   believes it still holds: it is written at launch and deleted only by a
 *   SUCCESSFUL retire, so an agent that exited unretired still has one.
 * - `git worktree list` in each repository those point at, which catches what
 *   the first misses — a worktree from before runtime state was persisted, or
 *   one whose retire refused and left the branch behind.
 *
 * OWNERSHIP IS THE BRANCH PREFIX, not the path. `basePath` is configurable, but
 * `agent-chat/<name>` is what `branchFor` writes and nothing else creates. This
 * is what keeps the sweep off Claude Code's OWN agent worktrees, which sit in
 * `.claude/worktrees/agent-*` on ordinary branch names and are usually locked:
 * a different tool's leak, not reachable from here, and pretending otherwise
 * would be worse than ignoring them.
 */

/** Where a worktree sits in the lifecycle, and therefore what may be done to it. */
export type SweepStatus =
  /** Its agent is still running. Nothing to do, and nothing safe to do. */
  | 'held'
  /** Its agent has exited, but inside the window that protects unnoticed work. */
  | 'in-grace'
  /** Uncommitted changes, or commits that exist nowhere else. Needs a person. */
  | 'holds-work'
  /** Nobody is using it and nothing would be lost. `prune` takes these. */
  | 'reclaimable'

export interface SweptWorktree {
  gitRoot: string
  worktree: string
  branch: string
  status: SweepStatus
  /** Absent when the branch exists but no identity in the log claims it. */
  agent?: { agentId: string; name: string; state: string; lastEventAt: number }
  /** One line of why it is in this state, for a human reading the report. */
  detail: string
}

/** Agent ids that currently have runtime state on disk, newest first. */
function agentIdsWithState(): string[] {
  try {
    return fs.readdirSync(agentsDir()).filter(id => fs.existsSync(runtimeStatePath(id)))
  } catch {
    return []
  }
}

const isWorktreeAllocation = (alloc: Allocation): boolean =>
  alloc.ref?.branch !== undefined && alloc.ref.worktree !== undefined && alloc.ref.gitRoot !== undefined

/** What runtime state says is still held, keyed by branch so git can be joined to it. */
export function heldByRuntimeState(): Map<string, { agentId: string; allocation: Allocation }> {
  const held = new Map<string, { agentId: string; allocation: Allocation }>()
  for (const agentId of agentIdsWithState()) {
    const state = readRuntimeState(agentId)
    if (state === undefined || state.isolation !== 'worktree') continue
    if (!isWorktreeAllocation(state.allocation)) continue
    held.set(state.allocation.ref?.branch as string, { agentId, allocation: state.allocation })
  }
  return held
}

export type GitLister = (gitRoot: string) => Promise<string>

/** Every worktree in `gitRoot` carrying an agent-chat branch, from git itself. */
export async function agentWorktreesIn(
  gitRoot: string,
  list: GitLister,
): Promise<{ worktree: string; branch: string }[]> {
  const out = await list(gitRoot).catch(() => '')
  return (
    out
      .split('\n\n')
      .map(block => ({
        worktree: block.match(/^worktree (.+)$/m)?.[1]?.trim(),
        branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1]?.trim(),
        locked: /^locked/m.test(block),
      }))
      .filter(
        (entry): entry is { worktree: string; branch: string; locked: boolean } =>
          entry.worktree !== undefined && entry.branch !== undefined,
      )
      // Locked is another tool's "do not touch"; honour it rather than reporting a
      // reclaim we would then refuse to perform.
      .filter(entry => !entry.locked && entry.branch.startsWith(BRANCH_PREFIX))
      .map(({ worktree, branch }) => ({ worktree: path.resolve(worktree), branch }))
  )
}

/** Live means someone is in it; anything else has stopped and may be reclaimable. */
const isLive = (state: string): boolean => state === 'live' || state === 'spawning'

function classifyByAgent(
  agent: AgentIdentity | undefined,
  now: number,
): { status: SweepStatus; detail: string } | undefined {
  if (agent === undefined) return undefined
  if (isLive(agent.state)) return { status: 'held', detail: `${agent.name} is ${agent.state}` }
  const since = now - agent.lastEventAt
  if (since < RECLAIM_GRACE_MS)
    return {
      status: 'in-grace',
      detail: `${agent.name} stopped ${Math.round(since / 1000)}s ago; reclaimable after ${RECLAIM_GRACE_MS / 1000}s`,
    }
  return undefined
}

export interface SweepOptions {
  /**
   * Repositories to scan beyond the ones runtime state names. The CLI passes
   * the repo it was run in, which is what catches a worktree allocated before
   * runtime state was persisted — nothing on disk points at those.
   */
  roots?: readonly string[]
  list?: GitLister
  now?: () => number
}

const porcelain: GitLister = async gitRoot =>
  (await import('node:child_process')).execFileSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: gitRoot,
    encoding: 'utf8',
  })

/**
 * Every agent-chat worktree this machine is holding, classified.
 *
 * `roster` is the agent log's view, passed in rather than read here: the log
 * lives behind the broker, and a sweep that could not run without one would be
 * useless in exactly the situation it is for.
 */
export async function sweepWorktrees(
  roster: readonly AgentIdentity[],
  options: SweepOptions = {},
): Promise<SweptWorktree[]> {
  const list = options.list ?? porcelain
  const now = (options.now ?? Date.now)()
  const held = heldByRuntimeState()
  const byBranch = new Map(roster.map(agent => [`${BRANCH_PREFIX}${agent.name}`, agent]))

  const roots = new Set<string>(options.roots ?? [])
  for (const { allocation } of held.values()) roots.add(allocation.ref?.gitRoot as string)

  const swept: SweptWorktree[] = []
  for (const gitRoot of roots) {
    for (const { worktree, branch } of await agentWorktreesIn(gitRoot, list)) {
      swept.push(await classify({ gitRoot, worktree, branch }, byBranch.get(branch), held, now))
    }
  }
  return swept
}

/**
 * Ownership is joined on the branch, so `agent` is absent for a worktree whose
 * agent predates the log or was pruned from it. That is reported rather than
 * assumed either way: an unknown owner is not a reason to destroy commits, and
 * the dirty/unmerged check below is what actually decides.
 */
async function classify(
  found: { gitRoot: string; worktree: string; branch: string },
  agent: AgentIdentity | undefined,
  held: ReturnType<typeof heldByRuntimeState>,
  now: number,
): Promise<SweptWorktree> {
  const owner = agent && {
    agentId: agent.agentId,
    name: agent.name,
    state: agent.state,
    lastEventAt: agent.lastEventAt,
  }
  const byAgent = classifyByAgent(agent, now)
  if (byAgent) return { ...found, ...byAgent, ...(owner ? { agent: owner } : {}) }

  const base = held.get(found.branch)?.allocation.ref?.base ?? 'HEAD'
  const safety = await inspectForRelease(found.gitRoot, found.worktree, found.branch, base)
  const unsafe = safety.dirty || safety.unmerged
  return {
    ...found,
    ...(owner ? { agent: owner } : {}),
    status: unsafe ? 'holds-work' : 'reclaimable',
    detail: unsafe
      ? [safety.dirty && 'uncommitted changes', safety.unmerged && 'commits that exist nowhere else']
          .filter(Boolean)
          .join(' and ')
      : agent === undefined
        ? 'no agent in the log claims this branch, and it holds nothing'
        : `${agent.name} is ${agent.state}, and it holds nothing`,
  }
}

/**
 * Destroy one swept worktree and its branch, and forget the allocation.
 *
 * Refuses anything not `reclaimable` unless forced, so the classification above
 * is the guard rather than advice. Clearing the runtime state is what stops the
 * next sweep re-reporting an allocation that is already gone.
 */
export async function reclaim(
  entry: SweptWorktree,
  options: { force?: boolean } = {},
): Promise<{ ok: boolean; reason?: string }> {
  if (entry.status !== 'reclaimable' && options.force !== true)
    return { ok: false, reason: `${entry.branch} is ${entry.status} — ${entry.detail}` }

  const alloc = heldByRuntimeState().get(entry.branch)
  const allocation: Allocation = alloc?.allocation ?? {
    cwd: entry.worktree,
    ref: { branch: entry.branch, worktree: entry.worktree, gitRoot: entry.gitRoot },
  }
  // Forced at the strategy either way: the grace window and the dirty/unmerged
  // check have already run, in `classify`, against the report the caller read.
  // Letting release re-derive them would refuse a reclaim the human just saw
  // offered, on an `exitedAt` this call site does not have.
  const released = await worktreeStrategy.release(
    { agentId: alloc?.agentId ?? '', agentName: entry.agent?.name ?? entry.branch, baseCwd: entry.gitRoot },
    allocation,
    { force: true },
  )
  if (released && alloc !== undefined) fs.rmSync(runtimeStatePath(alloc.agentId), { force: true })
  return released ? { ok: true } : { ok: false, reason: `git would not release ${entry.worktree}` }
}
