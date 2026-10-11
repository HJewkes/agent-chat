import type { AgentEventRow } from '../../broker/event-store.js'
import type { AgentIdentity } from '../../protocol.js'
import { isReviewerSpawn } from '../reviewer-tree.js'
import { allocatedWorktree } from './park.js'
import { isFinishedReport, parkable } from './retire-at-report.js'

/**
 * CC-976: a reviewer that exited on its final Verdict has its tree parked even when its spawner
 * never opted into CC-921, because a review tree holds no work: the park keeps the branch, and
 * `agent resume` re-creates the tree for a verdict correction. The agent is not retired.
 *
 * Shepherd's reviewers never message their spawner; Shepherd reads the Verdict from the last
 * assistant turn of the transcript, often after a lead-in paragraph. So a Verdict line anywhere
 * in either the last report or the final assistant text counts.
 */

export interface ReviewerParkPort {
  current(agentId: string): AgentIdentity | undefined
  events(): readonly AgentEventRow[]
  /** The agent's last report to its spawner in this run, if any. */
  lastReport(agent: AgentIdentity): string | undefined
  /** The final assistant text of the agent's transcript, if any. */
  finalText(agent: AgentIdentity): string | undefined
  /** `agent park` by id: refuses a live-cwd, dirty, off-branch or unpushed tree, and keeps the branch. */
  park(agentId: string): Promise<{ ok: boolean; reason?: string }>
}

export type ReviewerParkResult =
  | { action: 'off' }
  | { action: 'kept'; name: string; reason: string }
  | { action: 'parked'; name: string; reason?: string }

export const NO_VERDICT = 'no final Verdict report'

const VERDICT_LINE = /^[\s*_`#>]*verdict[*_`]*\s*:/im

export const isVerdictText = (text: string): boolean => isFinishedReport(text) || VERDICT_LINE.test(text)

/** Never rejects: a failure is a kept tree with the reason, named by id when the agent could not be read. */
export async function parkReviewerAtReport(
  port: ReviewerParkPort,
  agentId: string,
): Promise<ReviewerParkResult> {
  let name = agentId
  try {
    const agent = port.current(agentId)
    if (agent?.origin !== 'spawned' || !isReviewerSpawn(agent.profile, agent.name)) return { action: 'off' }
    name = agent.name
    return await parkFinished(port, agent)
  } catch (err) {
    return { action: 'kept', name, reason: (err as Error).message }
  }
}

async function parkFinished(port: ReviewerParkPort, agent: AgentIdentity): Promise<ReviewerParkResult> {
  const kept = (reason: string): ReviewerParkResult => ({ action: 'kept', name: agent.name, reason })
  if (!parkable(allocatedWorktree(port.events(), agent.agentId))) return { action: 'off' }
  if (!hasVerdict(port, agent)) return kept(NO_VERDICT)
  const parked = await port.park(agent.agentId)
  if (!parked.ok) return kept(parked.reason ?? 'park refused')
  return {
    action: 'parked',
    name: agent.name,
    ...(parked.reason === undefined ? {} : { reason: parked.reason }),
  }
}

const hasVerdict = (port: ReviewerParkPort, agent: AgentIdentity): boolean =>
  [port.lastReport(agent), port.finalText(agent)].some(text => text !== undefined && isVerdictText(text))
