import fs from 'node:fs'
import { supersededMarkerPath } from '../../agents/launch-files.js'

export const STALE_REASON =
  'This session was resumed from a transcript that a teleport has since superseded, so a newer session now holds this name. It takes no turn. Close it.'

/** The UserPromptSubmit output that stops a prompt reaching the model, or '' to let it through. */
export function staleGuardOutput(superseded: boolean): string {
  return superseded ? JSON.stringify({ decision: 'block', reason: STALE_REASON }) : ''
}

/** `agent-chat stale-session-guard <agentId>`: blocks every prompt of a session whose identity a teleport retired (CC-762). */
export function staleSessionGuard(agentId: string): void {
  const out = staleGuardOutput(fs.existsSync(supersededMarkerPath(agentId)))
  if (out !== '') process.stdout.write(`${out}\n`)
}
