import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import type { AgentEventRow } from '../../broker/event-store.js'
import type { AgentIdentity } from '../../protocol.js'
import { canonicalPath, isAtOrUnder } from '../spawn-cwd.js'
import type { MergedPrReader } from './merged-pr.js'
import { occupantOf } from './sweep.js'
import { parkIgnoredFiles } from './unsaved-work.js'
import {
  parkWorktree as parkTree,
  type ParkLocalBackingReader,
  type WorktreeRecord,
} from '@titan-design/worktree'

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

const DEFAULT_FETCH_MS = 30_000

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i

/**
 * CC-1064: GitHub's merged PRs on the branch HEAD is on, offered as local backing for a squash merge
 * whose head branch origin deleted. The package proves HEAD is in a candidate's local head commit and
 * reports its ref, which is the PR number; a malformed sha is dropped so the rest still count.
 */
const mergedPrBacking =
  (read: MergedPrReader, gitRoot: string): ParkLocalBackingReader =>
  async ({ branch }) =>
    (await read(gitRoot, branch).catch(() => []))
      .filter(pr => OBJECT_ID.test(pr.headSha))
      .map(pr => ({ oid: pr.headSha, ref: String(pr.number) }))

type Kept = { branch: string; containedIn?: string; mergedPr?: number }

/**
 * Refuse a tree that would lose anything; otherwise remove it without --force and keep the branch.
 * HEAD may sit on the allocated branch or another local one (a successor or adopted tree on the PR
 * branch); origin must hold it under that name or any other, or a merged PR's head must, or with no
 * origin the kept local branch is the copy. `recheck` runs right before the removal, so a spawn or
 * resume that started meanwhile is caught.
 */
export async function parkWorktree(
  target: ParkTarget,
  recheck: () => string | undefined,
  /** Set for an untracked detached agent: the lister that finds a process still in the tree. */
  listCwds?: CwdLister,
  /** Set by the broker: GitHub's merged PRs, for a squash-merged branch origin deleted. */
  mergedPr?: MergedPrReader,
): Promise<({ ok: true; head: string } & Kept) | { ok: false; reason: string }> {
  const occupied = listCwds && (await occupiedByProcess(target.worktree, listCwds))
  if (occupied) return { ok: false, reason: occupied }
  const options = {
    allowOriginHeadAncestor: true as const,
    allowDefaultBranchAncestor: true,
    fetchTimeoutMs: DEFAULT_FETCH_MS,
    ignoredFiles: parkIgnoredFiles,
  }
  if (mergedPr === undefined) return parkTree(target, recheck, options)
  const backing = mergedPrBacking(mergedPr, target.gitRoot)
  const result = await parkTree(target, recheck, { ...options, localBackingCandidates: backing })
  if (!result.ok) return result
  const { backingRef, ...parked } = result
  return backingRef === undefined ? parked : { ...parked, mergedPr: Number(backingRef) }
}
