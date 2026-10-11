import { isReviewerSpawn } from '../reviewer-tree.js'
import { BRANCH_PREFIX } from './worktree.js'
import type { SweptWorktree } from './sweep.js'

/**
 * CC-284: the words a seat counts worktrees in (CC-276 A4). The sweep's statuses answer
 * "what may prune do"; these answer "how much headroom does this repo have", so a seat
 * quotes one line instead of hand-counting held versus reclaimable rows.
 */
export type WorktreeState = 'active' | 'parkable' | 'reviewer-scratch' | 'non-seat' | 'stale'

export interface StateRow {
  state: WorktreeState
  branch: string
  worktree: string
  /** The sweep status behind the state, absent for a non-seat tree the sweep never sees. */
  status?: SweptWorktree['status']
  detail: string
}

export interface RepoHeadroom {
  gitRoot: string
  active: number
  parkable: number
  nonSeat: number
  budget: number
  free: number
  freeDiskBytes: number
  rows: StateRow[]
}

export const LOW_DISK_BYTES = 50 * 1024 ** 3

const isReviewerTree = (entry: SweptWorktree): boolean =>
  isReviewerSpawn('', entry.agent?.name ?? entry.branch.slice(BRANCH_PREFIX.length))

export function rowState(entry: SweptWorktree): WorktreeState {
  if (entry.status === 'held' || entry.status === 'in-grace') return 'active'
  if (isReviewerTree(entry)) return 'reviewer-scratch'
  return entry.status === 'reclaimable' ? 'parkable' : 'stale'
}

export function stateRow(entry: SweptWorktree): StateRow {
  const { branch, worktree, status, detail } = entry
  return { state: rowState(entry), branch, worktree, status, detail }
}

export function nonSeatRow(tree: { path: string; branch?: string }): StateRow {
  return {
    state: 'non-seat',
    branch: tree.branch ?? '(detached)',
    worktree: tree.path,
    detail: 'not an agent-chat branch',
  }
}

/** Free slots are what the budget leaves after the trees that cannot be parked. */
export function repoHeadroom(
  gitRoot: string,
  rows: StateRow[],
  budget: number,
  freeDiskBytes: number,
): RepoHeadroom {
  const count = (state: WorktreeState): number => rows.filter(r => r.state === state).length
  const active = count('active')
  const nonSeat = count('non-seat')
  const free = Math.max(0, budget - active - nonSeat)
  return { gitRoot, active, parkable: count('parkable'), nonSeat, budget, free, freeDiskBytes, rows }
}

export const repoSummary = (r: RepoHeadroom): string =>
  `${r.gitRoot}: active ${r.active}, parkable ${r.parkable}, non-seat ${r.nonSeat}, budget ${r.budget}, free ${r.free}`

export function lowDiskWarning(gitRoot: string, freeDiskBytes: number): string | undefined {
  if (freeDiskBytes >= LOW_DISK_BYTES) return undefined
  const gb = (freeDiskBytes / 1024 ** 3).toFixed(1)
  return `warning: ${gb} GB free on the volume holding ${gitRoot}, under 50 GB`
}

export function formatRows(rows: StateRow[]): string[] {
  return rows.flatMap(row => [
    `${row.state.padEnd(16)} ${row.branch.padEnd(28)} ${row.worktree}`,
    `${' '.repeat(16)} ${row.status === undefined ? row.detail : `${row.status}: ${row.detail}`}`,
  ])
}
