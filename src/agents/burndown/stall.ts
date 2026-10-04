import type { AgentIdentity } from '../../protocol.js'
import type { Activity } from '../turns.js'
import type { Claim } from './ledger.js'

/**
 * Whether a claimed agent is still moving, from its transcript alone (CC-653).
 * Pure: the caller reads the transcript with `readActivity`. Thresholds and
 * their evidence are in the CC-639 plan; every boundary is strict, so an agent
 * exactly at a threshold still reads working.
 */

/** No progress row and no open tool call for this long. */
export const IDLE_AFTER_MS = 5 * 60_000
/** A Bash or Monitor call open this long; a verify run routinely passes 5 min. */
export const BASH_TOOL_MS = 15 * 60_000
/** Any other tool call open this long, usually a permission prompt nobody will answer. */
export const TOOL_MS = 5 * 60_000
/** No progress row since the claim's phase began or its agent spawned. */
export const SILENT_AFTER_MS = 5 * 60_000

const LONG_TOOLS = new Set(['Bash', 'Monitor'])

export type StallReason = 'silent' | 'idle' | 'slow-tool'
export type Stall = { state: 'working' } | { state: 'stalled'; reason: StallReason } | { state: 'unknown' }

/** `unknown` is a session-read window the caller could not use; it never reads idle. */
export type ActivityRead = Activity | 'missing' | 'unreadable' | 'unknown'

const WORKING: Stall = { state: 'working' }
const stalled = (reason: StallReason): Stall => ({ state: 'stalled', reason })
const olderThan = (at: number, limit: number, now: Date): boolean => now.getTime() - at > limit

export function classify(
  activity: ActivityRead,
  claim: Pick<Claim, 'phaseAt'>,
  row: Pick<AgentIdentity, 'spawnedAt'>,
  now: Date,
): Stall {
  if (activity === 'unreadable' || activity === 'unknown') return { state: 'unknown' }
  const since = Math.max(Date.parse(claim.phaseAt), row.spawnedAt)
  const lastAt =
    activity === 'missing' || activity.lastAt === undefined ? undefined : Date.parse(activity.lastAt)
  if (lastAt === undefined || !(lastAt > since)) {
    return olderThan(since, SILENT_AFTER_MS, now) ? stalled('silent') : WORKING
  }
  if (activity !== 'missing' && activity.pending !== undefined) {
    const limit = LONG_TOOLS.has(activity.pending.tool) ? BASH_TOOL_MS : TOOL_MS
    return olderThan(Date.parse(activity.pending.at), limit, now) ? stalled('slow-tool') : WORKING
  }
  return olderThan(lastAt, IDLE_AFTER_MS, now) ? stalled('idle') : WORKING
}
