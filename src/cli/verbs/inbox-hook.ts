import fs from 'node:fs'
import { supersededMarkerPath } from '../../agents/launch-files.js'
import { drainInbox, releaseClaims, type DrainDeps } from '../../inbox-spool/drain.js'
import { inboxSpoolDir } from '../../server/inbox-spool.js'
import { readStdin } from './permission-hook.js'

/** CC-1455: where a print-mode (`claude -p`) session sees the pushes Claude Code dropped. */

const HOOK_EVENTS = { post: 'PostToolUse', prompt: 'UserPromptSubmit', stop: 'Stop' } as const
export type InboxHookPhase = keyof typeof HOOK_EVENTS

const HEADER =
  'agent-chat messages that arrived while this session ran. A print-mode session takes no channel pushes, ' +
  'so they are shown here; each is from the peer named in from, not from your user.'

const isPhase = (phase: string): phase is InboxHookPhase => Object.hasOwn(HOOK_EVENTS, phase)

function stopHookActive(raw: string): boolean {
  try {
    return (JSON.parse(raw) as { stop_hook_active?: unknown }).stop_hook_active === true
  } catch {
    return false
  }
}

function hookOutput(phase: InboxHookPhase, context: string): string {
  if (phase === 'stop') return JSON.stringify({ decision: 'block', reason: context })
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: HOOK_EVENTS[phase], additionalContext: context },
  })
}

/**
 * The hook's stdout, or '' when there is nothing to show. A superseded identity
 * claims nothing, and a Stop re-entry never blocks again, so a turn always ends.
 */
export function inboxHookOutput(
  agentId: string,
  phase: string,
  raw: string,
  deps: DrainDeps = {},
): { out: string; claimed: string[] } {
  const none = { out: '', claimed: [] }
  if (!isPhase(phase) || fs.existsSync(supersededMarkerPath(agentId))) return none
  if (phase === 'stop' && stopHookActive(raw)) return none
  const drained = drainInbox(inboxSpoolDir(agentId), deps)
  if (drained.blocks.length === 0) return none
  return { out: hookOutput(phase, [HEADER, ...drained.blocks].join('\n\n')), claimed: drained.claimed }
}

/** `agent-chat inbox-hook <agentId> <post|prompt|stop>`: never fails the tool call (same posture as seat-hook). */
export async function inboxHook(agentId: string, phase: string): Promise<void> {
  try {
    const { out, claimed } = inboxHookOutput(agentId, phase, await readStdin())
    if (out === '') return
    process.stdout.write(`${out}\n`)
    releaseClaims(claimed)
  } catch {
    // A claim left behind is recovered by a later drain once its pid is gone.
  }
}
