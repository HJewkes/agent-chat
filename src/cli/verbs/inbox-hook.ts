import fs from 'node:fs'
import { supersededMarkerPath } from '../../agents/launch-files.js'
import { EventLog } from '../../broker/event-log.js'
import type { AppendInput } from '../../broker/event-store.js'
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

function hookPayload(raw: string): { stop_hook_active?: unknown; session_id?: unknown } {
  try {
    return JSON.parse(raw) as { stop_hook_active?: unknown; session_id?: unknown }
  } catch {
    return {}
  }
}

const stopHookActive = (raw: string): boolean => hookPayload(raw).stop_hook_active === true

function hookOutput(phase: InboxHookPhase, context: string): string {
  if (phase === 'stop') return JSON.stringify({ decision: 'block', reason: context })
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: HOOK_EVENTS[phase], additionalContext: context },
  })
}

/**
 * The hook's stdout, or '' when there is nothing to show. A superseded identity
 * claims nothing, and a Stop re-entry never blocks again, so a turn always ends.
 * A Stop without `stopBlocks` claims nothing either: the next prompt shows the spool.
 */
export function inboxHookOutput(
  agentId: string,
  phase: string,
  raw: string,
  deps: DrainDeps = {},
  stopBlocks = false,
): { out: string; claimed: string[]; msgIds: string[] } {
  const none = { out: '', claimed: [], msgIds: [] }
  if (!isPhase(phase) || fs.existsSync(supersededMarkerPath(agentId))) return none
  if (phase === 'stop' && (!stopBlocks || stopHookActive(raw))) return none
  const drained = drainInbox(inboxSpoolDir(agentId), deps)
  if (drained.blocks.length === 0) return none
  return {
    out: hookOutput(phase, [HEADER, ...drained.blocks].join('\n\n')),
    claimed: drained.claimed,
    msgIds: drained.msgIds,
  }
}

/**
 * The receipt for one drain that printed: an `inbox_shown` row naming the msgIds
 * shown, written straight into events.db the way seat-hook does, never through the
 * broker. Called only on the hit path, so an empty drain costs no SQLite open.
 */
export function recordShown(
  log: { append(input: AppendInput): unknown },
  actor: string,
  raw: string,
  msgIds: string[],
): void {
  const sessionId = hookPayload(raw).session_id
  log.append({
    kind: 'inbox_shown',
    actor,
    ...(typeof sessionId === 'string' ? { ref: sessionId } : {}),
    meta: { msgIds: msgIds.join(',') },
  })
}

function writeReceipt(agentId: string, raw: string, msgIds: string[]): void {
  const log = new EventLog()
  try {
    recordShown(log, process.env.AGENT_CHAT_NAME || agentId, raw, msgIds)
  } finally {
    log.close()
  }
}

/** `agent-chat inbox-hook <agentId> <post|prompt|stop> [--block]`: never fails the tool call (same posture as seat-hook). */
export async function inboxHook(agentId: string, phase: string, block = false): Promise<void> {
  try {
    const raw = await readStdin()
    const { out, claimed, msgIds } = inboxHookOutput(agentId, phase, raw, {}, block)
    if (out === '') return
    process.stdout.write(`${out}\n`)
    releaseClaims(claimed)
    writeReceipt(agentId, raw, msgIds)
  } catch {
    // A claim left behind is recovered by a later drain once its pid is gone; a lost receipt costs only the row.
  }
}
