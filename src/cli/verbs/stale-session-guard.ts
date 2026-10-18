import fs from 'node:fs'
import { supersededMarkerPath } from '../../agents/launch-files.js'

/** CC-1450: a failed teleport can leave this session live, so the reader is sent to the roster, not told to close it. */
export const staleReason = (agentId: string): string =>
  `Agent ${agentId} was superseded by a teleport, so this prompt was not delivered. ` +
  'Check `agent-chat agent ls --prefix <name>` before closing this session: if this id is still the live one, keep it.'

/** The UserPromptSubmit output that stops a prompt reaching the model, or '' to let it through. */
export function staleGuardOutput(agentId: string): string {
  if (!fs.existsSync(supersededMarkerPath(agentId))) return ''
  return JSON.stringify({ decision: 'block', reason: staleReason(agentId) })
}

/** `agent-chat stale-session-guard <agentId>`: blocks every prompt of a session whose identity a teleport retired (CC-762). */
export function staleSessionGuard(agentId: string): void {
  const out = staleGuardOutput(agentId)
  if (out !== '') process.stdout.write(`${out}\n`)
}
