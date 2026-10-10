import { existsSync } from 'node:fs'
import type { AgentEventRow } from '../../broker/event-store.js'
import type { AgentIdentity } from '../../protocol.js'
import { allocatedWorktree, type ParkTarget } from './park.js'
import { adopterBlocker, liveBlocker } from './retire-finished.js'
import { shepherdSkip, type ShepherdSkipPort } from './shepherd-skip.js'

/**
 * CC-921: when an opted-in spawner's agent exits after a final `Status:` or `Verdict:`
 * report, the broker parks its clean, pushed tree and retires it, so seats stop spending
 * calls on closeout. The park keeps the branch and the retire keeps it too: nothing on this
 * path deletes a branch. Every check errs towards keeping: a kept tree costs a manual
 * retire, a wrong retire costs work or a Shepherd fix round.
 */

type Outcome = { ok: boolean; reason?: string }

export interface ReportRetirePort {
  current(agentId: string): AgentIdentity | undefined
  roster(): AgentIdentity[]
  events(): readonly AgentEventRow[]
  /** Whether the spawner opted in through `autoRetire.onFinalReport`. */
  enabledFor(spawner: string): boolean
  /** The agent's last report to its spawner in this run is a terminal `Status:` or `Verdict:`. */
  finalReport(agent: AgentIdentity): boolean
  /** This broker still watches the agent's process. */
  tracked(agentId: string): boolean
  skip: ShepherdSkipPort
  /** `agent park` by id: refuses a live-cwd, dirty, off-branch or unpushed tree, and keeps the branch. */
  park(agentId: string): Promise<Outcome>
  /** Retire by id with a branch-keeping release. */
  retire(agentId: string): Promise<Outcome>
}

export type ReportRetireResult =
  | { action: 'off' }
  | { action: 'kept'; name: string; reason: string }
  | { action: 'retired'; name: string; parked: boolean; reason?: string }

/** Never rejects: a failure is a kept agent with the reason. */
export async function retireAtReport(port: ReportRetirePort, agentId: string): Promise<ReportRetireResult> {
  const agent = port.current(agentId)
  if (agent?.origin !== 'spawned' || !port.enabledFor(agent.spawnedBy)) return { action: 'off' }
  const kept = (reason: string): ReportRetireResult => ({ action: 'kept', name: agent.name, reason })
  try {
    if (!port.finalReport(agent)) return kept('no final Status or Verdict report')
    const target = allocatedWorktree(port.events(), agentId)
    const blocked =
      adopterBlocker(agent, target, port.roster()) ?? (await shepherdSkip(port.skip, agent, target))
    if (blocked) return kept(blocked)
    const parked = parkable(target) ? await port.park(agentId) : undefined
    if (parked?.ok === false) return kept(parked.reason ?? 'park refused')
    const late = lateBlocker(port, agentId, agent.name)
    if (late) return kept(late)
    const retired = await port.retire(agentId)
    if (!retired.ok) return kept(retired.reason ?? 'retire refused')
    return { action: 'retired', name: agent.name, parked: parked !== undefined, ...reasonOf(retired) }
  } catch (err) {
    return kept((err as Error).message)
  }
}

/** An adopted tree belongs to its owner and a gone one has nothing left to remove. */
const parkable = (target: ParkTarget | undefined): target is ParkTarget =>
  target !== undefined && !target.assigned && existsSync(target.worktree)

/** The checks await, so the agent may have been resumed meanwhile. */
function lateBlocker(port: ReportRetirePort, agentId: string, name: string): string | undefined {
  const now = port.current(agentId)
  if (now?.name !== name) return 'no longer the agent that exited'
  const live = liveBlocker(now, port.tracked(agentId))
  return live === undefined ? undefined : `became ${live} before the retire`
}

const reasonOf = (res: Outcome): { reason?: string } =>
  res.reason === undefined ? {} : { reason: res.reason }
