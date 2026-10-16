import { endHostSession } from '../agents/end-session.js'

export interface EndSelfDeps {
  /** This process's spawn identity; an ordinary session has none and ends on no `end_self`. */
  ownAgentId: string | undefined
  /** The Claude Code this MCP process serves. */
  hostPid: number | undefined
  end?: (name: string, hostPid: number) => { ok: boolean; reason?: string }
  log: (event: string, fields: Record<string, unknown>) => void
}

/**
 * CC-1059: the broker retired this agent from another host and cannot signal its pid, so it asks
 * the agent's own MCP process to end its Claude Code. Only a frame naming this process's own
 * agent id does that; any other is a misroute and is logged, never acted on.
 */
export function endSelfHandler(deps: EndSelfDeps): (agentId: string, reason: string) => void {
  const end = deps.end ?? endHostSession
  return (agentId, reason) => {
    const own = deps.ownAgentId !== undefined && agentId === deps.ownAgentId
    if (!own || deps.hostPid === undefined) {
      deps.log('end_self_ignored', { agentId, own, hostPid: deps.hostPid ?? null, reason })
      return
    }
    deps.log('end_self', { agentId, hostPid: deps.hostPid, reason })
    end('this agent', deps.hostPid)
  }
}
