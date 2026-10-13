import type { AgentLifecycle } from '../../protocol.js'
import type { Ledger } from '../burndown/ledger.js'
import type { SeatSummary } from '../burndown/tick-summary.js'

/**
 * CC-1282 (K1): the live state every count derives from, and the counts derived from it. Live state is the truth:
 * the ledger, the semaphore and spawn-time claims are caches, and each item a cache holds beyond live state carries
 * one verdict from a closed set.
 */

/** A reader's result: its value, or why it could not be read. An unread value is never treated as empty. */
export type Read<T> = { value: T } | { error: string }

export interface RosterRow {
  agentId: string
  name: string
  profile: string
  state: AgentLifecycle
  cwd?: string
}

export interface Roster {
  rows: RosterRow[]
  /** Why some rows are missing: a name absent from a partial roster is unread, never live and never gone. */
  partial?: string
}

export interface ProcessRow {
  pid: number
  agentId?: string
  name?: string
}

export interface FileClaim {
  owner: string
  repo: string
  patterns: string[]
}

export interface WorktreeRow {
  path: string
  branch?: string
}

export interface PrRow {
  /** As the ledger records it on `Claim.pr`. */
  pr: string
  state: 'open' | 'closed' | 'merged'
}

export interface ShepherdRun {
  pr: string
  ended: boolean
  /** The tree a fix round runs in, when it has one. */
  worktree?: string
}

export interface Shepherd {
  runs: ShepherdRun[]
  /** Shepherd's own reviewer-slot reading (K14); absent from a Shepherd that does not export it. */
  reviewSlots?: { running: string[]; cap: number }
}

export const PARK_KEPT_CLASSES = [
  'claim-hold',
  'shepherd-fix-round',
  'ignored-files',
  'dirty',
  'unpushed',
  'process',
  'error',
] as const
export type ParkKeptClass = (typeof PARK_KEPT_CLASSES)[number]

export interface ParkKept {
  tree: string
  class: ParkKeptClass
  reason: string
  at: string
}

export const SURFACES = ['tick', 'seats status', 'agent ls', 'budget', 'shepherd', 'ledger'] as const
export type Surface = (typeof SURFACES)[number]

/** A value a surface printed for a count, supplied by the caller that read that surface. */
export interface Shown {
  count: CountId
  seat?: string
  surface: Surface
  value: number
}

export interface LiveSnapshot {
  now: Date
  /** The tick interval, for the bounds stated in ticks. */
  tickMs: number
  /** The worktree sweep interval, for the `park-refused` bound. */
  sweepMs: number
  roster: Read<Roster>
  processes: Read<ProcessRow[]>
  /** Names of the seat and human sessions registered with the broker: they run a process but hold no slot. */
  sessions: Read<string[]>
  fileClaims: Read<FileClaim[]>
  worktrees: Record<string, Read<WorktreeRow[]>>
  prs: Record<string, Read<PrRow[]>>
  shepherd: Read<Shepherd>
  ledger: Read<Ledger>
  semaphore: Read<{ held: number; cap: number }>
  parkKept: Read<ParkKept[]>
  lastTick?: { seats: Record<string, Pick<SeatSummary, 'roles'>> }
  shown?: Shown[]
}

export const EXPLAIN_CODES = [
  'spawning',
  'respawn-pending',
  'in-review',
  'escalated',
  'stale-action-due',
  'slices-queued',
  'park-held',
  'park-refused',
  'parked-claim',
  'seat-session',
] as const
export type ExplainCode = (typeof EXPLAIN_CODES)[number]

export type Verdict =
  | { kind: 'agree' }
  | { kind: 'explained'; code: ExplainCode; since: string; maxAgeMs?: number }
  | { kind: 'unexplained'; why: string }
  | { kind: 'unread'; why: string }

export interface CountItem {
  key: string
  verdict: Verdict
}

export const COUNT_IDS = [
  'implementers',
  'reviewers',
  'planners',
  'claims',
  'worktrees',
  'slots',
  'file-claims',
  'shepherd-reviewers',
] as const
export type CountId = (typeof COUNT_IDS)[number]

export interface Count {
  id: CountId
  seat?: string
  repo?: string
  shown: { surface: Surface; value: number }[]
  /** Undefined when a reader the count needs failed; its items then carry an `unread` verdict. */
  live?: { value: number; derivation: string }
  items: CountItem[]
}
