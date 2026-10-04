import type { Observation } from './advance.js'
import type { Claim } from './ledger.js'
import type { Progress } from './progress.js'
import { BASH_TOOL_MS } from './stall.js'
import type { StallCode } from './stall-code.js'

/**
 * An implementing claim's lease (CC-659): a commit renews it outright, other
 * evidence (an edit, transcript progress, a long Bash call still running)
 * renews it only before it ends, and an ended lease is a verdict. Pure.
 */

export const LEASE_MS = 30 * 60_000
/** Renewals without a commit before the lease reads `no-progress`: about 2.5 h (CC-659 Q1). */
export const MAX_RENEWALS = 4

export type Lease = NonNullable<Claim['lease']>

export interface LeaseStep {
  /** Absent when the claim holds no lease. */
  lease?: Lease
  verdict?: StallCode
  /** The worktree could not be read: the lease is as it was, and says nothing. */
  unknown?: true
}

export interface LeaseContext {
  /** The claim's seat pool gate is closed, so the agent may be waiting on budget, not stuck. */
  parked: boolean
  now: Date
}

type Seen = Pick<Lease, 'head' | 'content' | 'transcriptAt'>

const LONG_TOOLS = new Set(['Bash', 'Monitor'])

const iso = (ms: number): string => new Date(ms).toISOString()

function seenIn(progress: Progress | undefined, obs: Observation): Seen {
  const read = obs.activity?.read
  const transcriptAt = typeof read === 'object' ? read.lastAt : undefined
  return {
    ...(progress === undefined ? {} : { head: progress.head, content: progress.content }),
    ...(transcriptAt === undefined ? {} : { transcriptAt }),
  }
}

/** The fresh-claim grace: a new lease runs from the phase start. */
function started(claim: Claim, obs: Observation): Lease {
  const progressAt = Date.parse(claim.phaseAt)
  const progress = typeof obs.progress === 'object' ? obs.progress : undefined
  return {
    progressAt: claim.phaseAt,
    leaseUntil: iso(progressAt + LEASE_MS),
    renewals: 0,
    ...seenIn(progress, obs),
  }
}

const isNewer = (at: string | undefined, than: string | undefined): boolean =>
  at !== undefined && than !== undefined && Date.parse(at) > Date.parse(than)

/** A Bash or Monitor call still inside CC-653's own limit is work in flight, such as a long verify run. */
function longCallOpen(obs: Observation, now: Date): boolean {
  const read = obs.activity?.read
  const pending = typeof read === 'object' ? read.pending : undefined
  return (
    pending !== undefined &&
    LONG_TOOLS.has(pending.tool) &&
    now.getTime() - Date.parse(pending.at) < BASH_TOOL_MS
  )
}

function hasEvidence(lease: Lease, seen: Seen, obs: Observation, now: Date): boolean {
  const edited = lease.content !== undefined && seen.content !== lease.content
  return edited || isNewer(seen.transcriptAt, lease.transcriptAt) || longCallOpen(obs, now)
}

/**
 * Renews at most once per lease window: evidence extends the lease by one
 * window once less than one is left, so a tick every 10 min cannot spend the
 * renewal cap in under an hour.
 */
function inWindow(lease: Lease, seen: Seen, obs: Observation, now: Date): LeaseStep {
  const until = Date.parse(lease.leaseUntil)
  const renews = hasEvidence(lease, seen, obs, now) && until - now.getTime() < LEASE_MS
  const next = renews
    ? { ...lease, ...seen, leaseUntil: iso(until + LEASE_MS), renewals: lease.renewals + 1 }
    : { ...lease, ...seen }
  return next.renewals > MAX_RENEWALS ? { lease: next, verdict: 'no-progress' } : { lease: next }
}

/** The claim's lease after this tick's observation, and the verdict it gives, if any. */
export function leaseStep(claim: Claim, obs: Observation, { parked, now }: LeaseContext): LeaseStep {
  if (claim.phase !== 'implementing' || claim.worktree === undefined) return {}
  const lease = claim.lease ?? started(claim, obs)
  if (typeof obs.progress !== 'object') return { lease, unknown: true }
  const progress = obs.progress
  const seen = seenIn(progress, obs)
  const nowMs = now.getTime()
  if (parked) {
    const leaseUntil = iso(Math.max(Date.parse(lease.leaseUntil), nowMs + LEASE_MS))
    return { lease: { ...lease, ...seen, leaseUntil } }
  }
  if (lease.head !== undefined && progress.head !== lease.head)
    return { lease: { progressAt: iso(nowMs), leaseUntil: iso(nowMs + LEASE_MS), renewals: 0, ...seen } }
  if (nowMs > Date.parse(lease.leaseUntil))
    return { lease, verdict: progress.dirtyCount > 0 ? 'dirty-uncommitted' : 'lease-expired' }
  return inWindow(lease, seen, obs, now)
}

/** Field by field, so a lease rebuilt in another key order is not a ledger write. */
export const sameLease = (a: Lease | undefined, b: Lease | undefined): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    (['progressAt', 'leaseUntil', 'renewals', 'head', 'content', 'transcriptAt'] as const).every(
      field => a[field] === b[field],
    ))
