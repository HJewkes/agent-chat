import type { Claim } from './ledger.js'
import type { SeatDispatch } from './seat-dispatch.js'

/**
 * CC-985: what a held claim takes from the seat, shared by the seat plan, its stall notices and the digest.
 * A claim always holds its task; it holds a lane only while CC-978/CC-1098 say it counts against its role.
 */

export type Role = keyof SeatDispatch['caps']

export type ClaimHold = 'lane + task' | 'task'

/** Whether an agent may run, by name; absent when the caller has no roster. */
export type LiveAgent = (name: string | undefined) => boolean

/** A stall named again once it has lasted this long. */
export const STALL_AGED_MS = 2 * 60 * 60 * 1000

const ROLE_OF_PHASE: Partial<Record<Claim['phase'], Role>> = {
  planning: 'planners',
  implementing: 'implementers',
  reviewing: 'reviewers',
}

/** A spawning claim counts toward the role it lands in. */
export const roleOf = (claim: Claim): Role | undefined =>
  ROLE_OF_PHASE[claim.phase === 'spawning' ? (claim.nextPhase ?? 'spawning') : claim.phase]

/**
 * CC-1098: a claim holds its role's slot while it is spawning, its agent may run, or a ladder respawn is about to
 * spawn its successor. One whose agent is gone is ledger state, not live work, even with a PR open at Shepherd.
 */
export const holdsSlot = (claim: Claim, live: LiveAgent | undefined): boolean =>
  claim.phase === 'spawning' || live === undefined || claim.respawn !== undefined || live(claim.agentName)

/**
 * With no roster, a claim classified stale (CC-1150 b: agent gone) and with no respawn pending holds only its task;
 * the respawn check guards a respawn begun after the claim was classified.
 */
const holdsSlotFromLedger = (claim: Claim): boolean =>
  claim.phase === 'spawning' || claim.stale === undefined || claim.respawn !== undefined

export function claimHold(claim: Claim, live?: LiveAgent): ClaimHold {
  if (roleOf(claim) === undefined) return 'task'
  const lane = live === undefined ? holdsSlotFromLedger(claim) : holdsSlot(claim, live)
  return lane ? 'lane + task' : 'task'
}

/** How long a claim has been stalled; a stall from before `stalledAt` was recorded counts from its phase change. */
export const stallAgeMs = (claim: Claim, now: Date): number =>
  now.getTime() - Date.parse(claim.stalledAt ?? claim.phaseAt)
