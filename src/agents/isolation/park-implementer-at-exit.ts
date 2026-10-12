import type { AgentEventRow } from '../../broker/event-store.js'
import type { AgentIdentity } from '../../protocol.js'
import { isReviewerSpawn } from '../reviewer-tree.js'
import { allocatedWorktree } from './park.js'
import { parkable } from './retire-at-report.js'

/**
 * CC-1039: a spawned non-reviewer agent's tree is parked when the agent exits normally, without
 * waiting for CI and without CC-921's opt-in, because a clean tree whose HEAD origin holds loses
 * nothing: the park keeps the branch and `agent resume` re-creates the tree for a fix round. The
 * `agent park` rules still decide, so a dirty, unpushed or occupied tree stays. A tree a burndown
 * claim still reads stays too, since parking it would stall the claim.
 */

export interface ImplementerParkPort {
  current(agentId: string): AgentIdentity | undefined
  events(): readonly AgentEventRow[]
  /** `autoPark.onExit`, read per exit. */
  enabled(): boolean
  /** Why a held burndown claim still reads `tree`, or undefined. */
  treeHold(tree: string): string | undefined
  /** `agent park` by id with the process check on. */
  park(agentId: string): Promise<{ ok: boolean; reason?: string }>
}

export type ImplementerParkResult =
  | { action: 'off' }
  | { action: 'kept'; name: string; reason: string }
  | { action: 'parked'; name: string; reason?: string }

/** Never rejects: a failure is a kept tree with the reason, named by id when the agent could not be read. */
export async function parkImplementerAtExit(
  port: ImplementerParkPort,
  agentId: string,
): Promise<ImplementerParkResult> {
  let name = agentId
  try {
    const agent = port.current(agentId)
    if (agent?.origin !== 'spawned' || isReviewerSpawn(agent.profile, agent.name)) return { action: 'off' }
    name = agent.name
    return await parkExited(port, agent)
  } catch (err) {
    return { action: 'kept', name, reason: (err as Error).message }
  }
}

async function parkExited(port: ImplementerParkPort, agent: AgentIdentity): Promise<ImplementerParkResult> {
  const target = allocatedWorktree(port.events(), agent.agentId)
  if (!parkable(target) || !port.enabled()) return { action: 'off' }
  const kept = (reason: string): ImplementerParkResult => ({ action: 'kept', name: agent.name, reason })
  const held = port.treeHold(target.worktree)
  if (held !== undefined) return kept(held)
  const parked = await port.park(agent.agentId)
  if (!parked.ok) return kept(parked.reason ?? 'park refused')
  return {
    action: 'parked',
    name: agent.name,
    ...(parked.reason === undefined ? {} : { reason: parked.reason }),
  }
}
