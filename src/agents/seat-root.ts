import type { IdentityBinding } from '../broker/registry.js'
import type { AgentIdentity, AgentOrigin } from '../protocol.js'
import { leasesName } from './seats/seat-target.js'
import { seatPolicyPath, type SeatPolicy, type SeatPolicyEntry } from './seat-policy.js'

/**
 * CC-1615: which requester holds a policy seat (CC-1580). Only a connection that presented the
 * broker-minted id of a row the broker launched (or teleported) under the seat's name, with a
 * launch profile the owner listed, is root. A name, a session id or an adopted identity is not.
 */

/** What the broker knows about the connection asking, read from its registry entry. */
export interface SeatClaim {
  binding?: IdentityBinding | undefined
  name?: string | undefined
}

/** The requester's own `agent_spawned` row, as the event log returns it. */
interface SpawnRow {
  target?: string | null
  meta: Record<string, string>
}

/** The seat a requester is root of, or undefined when any part of the proof is missing. */
export function seatRootOf(
  row: SpawnRow | undefined,
  claim: SeatClaim,
  policy: SeatPolicy,
): string | undefined {
  if (row === undefined || claim.binding !== 'launch') return undefined
  const seat = row.target
  if (seat === undefined || seat === null || claim.name !== seat) return undefined
  if (!startsSeatRoot(policy, seat, row.meta.profile ?? '')) return undefined
  const origin = row.meta.origin as AgentOrigin | undefined
  const teleportFrom = row.meta.teleport_from
  return leasesName({
    ...(origin === undefined ? {} : { origin }),
    ...(teleportFrom === undefined ? {} : { teleportFrom }),
  })
    ? seat
    : undefined
}

/**
 * CC-1616: the policy entry a listed identity would hold root under, for display. The roster does
 * not carry how the connection registered, so this is the row-side half of {@link seatRootOf}; the
 * broker still decides each spawn on the full proof.
 */
export function rootSeatEntry(
  agent: Pick<AgentIdentity, 'name' | 'profile' | 'origin' | 'teleportFrom'>,
  policy: SeatPolicy,
): SeatPolicyEntry | undefined {
  const entry = policySeat(policy, agent.name)
  if (entry === undefined || !entry.launchProfiles.includes(agent.profile)) return undefined
  const lease = {
    origin: agent.origin,
    ...(agent.teleportFrom === undefined ? {} : { teleportFrom: agent.teleportFrom }),
  }
  return leasesName(lease) ? entry : undefined
}

/** The policy entry a launch named `name` would take a seat under, whatever its profile. */
export const policySeat = (policy: SeatPolicy, name: string): SeatPolicyEntry | undefined =>
  Object.hasOwn(policy.seats, name) ? policy.seats[name] : undefined

/** Whether a launch of `name` with `profile` starts the seat's root holder. */
export const startsSeatRoot = (policy: SeatPolicy, name: string, profile: string): boolean =>
  policySeat(policy, name)?.launchProfiles.includes(profile) === true

/**
 * CC-1675: why a requester named `name`, running `profile`, is not a seat root, naming the policy
 * entry the owner would add. A listed entry means the connection failed the rest of the proof.
 */
export function seatRootGap(policy: SeatPolicy, name: string, profile: string): string {
  const entry = policySeat(policy, name)
  if (entry === undefined) return `"${name}" is not a seat in ${seatPolicyPath()}`
  if (!entry.launchProfiles.includes(profile))
    return `seat "${name}" in ${seatPolicyPath()} does not list profile "${profile}" in its launchProfiles`
  return `seat "${name}" is in ${seatPolicyPath()}, but this connection did not prove it holds the seat's launch`
}

/** The refusal for a root seat's spawn of a profile outside its ceiling. */
export function ceilingRefusal(seat: string, entry: SeatPolicyEntry, profile: string): string | undefined {
  if (entry.ceiling.includes(profile)) return undefined
  return (
    `profile "${profile}" is not in the spawn ceiling of seat "${seat}" in ${seatPolicyPath()}; ` +
    'only the owner can add it there, or ask the human to spawn it'
  )
}

/** The refusal for a ceiling profile whose file changed since broker start: its name is all the ceiling trusts. */
export const ceilingDriftRefusal = (seat: string, profile: string, drift: string): string =>
  `${drift}; seat "${seat}" spawns by profile name, so a changed profile is held until a human spawns it`
