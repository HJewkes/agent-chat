import type { AgentLog } from '../agents/identity.js'
import type { AgentIdentity } from '../protocol.js'
import type { AgentEventRow, EventStore } from './event-store.js'

/** CC-1552: why a connected session's peer mail and lifecycle events are logged to its inbox and not pushed. */
export type PushHold = 'retired' | 'parked'

const lastIndexOf = (rows: readonly AgentEventRow[], kind: AgentEventRow['kind']): number =>
  rows.findLastIndex(row => row.kind === kind)

/** `agent park` removed its tree and no `agent resume` has re-created it since. */
const treeParked = (rows: readonly AgentEventRow[]): boolean =>
  lastIndexOf(rows, 'isolation_parked') > lastIndexOf(rows, 'agent_resumed')

/**
 * A successor of a `reason: park` teleport waits on the human (CC-135) until the human
 * answers or writes to it, or it is resumed.
 */
function teleportParked(
  events: EventStore,
  identity: AgentIdentity,
  rows: readonly AgentEventRow[],
): boolean {
  const { teleportFrom, agentId, name } = identity
  if (teleportFrom === undefined || lastIndexOf(rows, 'agent_resumed') >= 0) return false
  const handoff = events
    .agentEventsFor(teleportFrom)
    .findLast(row => row.kind === 'agent_handoff' && row.meta.successor === agentId)
  return handoff?.meta.reason === 'park' && !events.humanContactSince(name, handoff.ts)
}

/** The hold on pushes to `agentId`'s session, if it has one; an unknown id is never held. */
export function pushHoldFor(events: EventStore, agents: AgentLog, agentId: string): PushHold | undefined {
  const identity = agents.get(agentId)
  if (identity === undefined) return undefined
  if (identity.state === 'retired') return 'retired'
  const rows = events.agentEventsFor(agentId)
  return treeParked(rows) || teleportParked(events, identity, rows) ? 'parked' : undefined
}
