import type { AgentLog } from '../agents/identity.js'
import type { EventStore } from './event-store.js'

/**
 * CC-1719: a remote teleport retires its predecessor even when the predecessor's
 * connection still holds the name and the successor never attaches, so the
 * predecessor runs on under a retired id. It counts as stranded, not gone, while
 * that successor keeps the name lease and has never attached: nobody else can own
 * the name, and the isolation was never released. Such a session may register
 * again after a broker restart and is woken by peer mail like any live one.
 */
export function strandedPredecessor(events: EventStore, agents: AgentLog, agentId: string): boolean {
  const identity = agents.get(agentId)
  if (identity?.state !== 'retired' || !agents.stoodDown(agentId)) return false
  const successor = agents.successorOf(agentId)
  if (successor === undefined || successor.name !== identity.name || successor.state === 'retired') return false
  return !events.agentEventsFor(successor.agentId).some(row => row.kind === 'agent_attached')
}
