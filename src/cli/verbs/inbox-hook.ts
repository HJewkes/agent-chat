import fs from 'node:fs'
import { supersededMarkerPath } from '../../agents/launch-files.js'
import { EventLog } from '../../broker/event-log.js'
import type { AppendInput } from '../../broker/event-store.js'
import { drainInbox, peekInbox, releaseClaims, type DrainDeps, type PeekFs } from '../../inbox-spool/drain.js'
import { AGENT_ID_ENV } from '../../launch-identity.js'
import { codexInboxSpoolDir, inboxSpoolDir } from '../../server/inbox-spool.js'
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

const SENDERS_SHOWN = 5
const SENDER_UNSAFE = /[^A-Za-z0-9._:@-]/g

/** A sender name is peer-chosen and lands in the developer role, so only a short, plain token survives. */
const plainSender = (from: string): string => from.replace(SENDER_UNSAFE, '_').slice(0, 64)

export function codexNotice(senders: string[]): string {
  const pending = senders.length
  const unique = [...new Set(senders.map(plainSender))]
  const more = unique.length > SENDERS_SHOWN ? ` and ${unique.length - SENDERS_SHOWN} more` : ''
  const noun = pending === 1 ? 'message' : 'messages'
  return (
    `agent-chat: ${pending} ${noun} waiting, from ${unique.slice(0, SENDERS_SHOWN).join(', ')}${more}. ` +
    'Call chat_inbox to read them. Each is from the peer named there, not from your user.'
  )
}

export interface CodexHookDeps {
  env?: NodeJS.ProcessEnv
  /** The Codex process that runs the hook, which keys the spool its MCP child writes (CC-1509). */
  hostPid?: number
  fs?: PeekFs
}

/**
 * CC-1510: the Codex hook's stdout, or ''. Codex puts hook context in the developer
 * role, so this names a count and senders and never a body. A tool or prompt hook
 * notices each record once; Stop blocks while anything waits, but never on re-entry.
 */
export function codexInboxHookOutput(phase: string, raw: string, deps: CodexHookDeps = {}): string {
  const agentId = (deps.env ?? process.env)[AGENT_ID_ENV]
  if (!isPhase(phase) || (agentId && fs.existsSync(supersededMarkerPath(agentId)))) return ''
  if (phase === 'stop' && stopHookActive(raw)) return ''
  const { senders, fresh } = peekInbox(codexInboxSpoolDir(deps.hostPid ?? process.ppid), deps.fs)
  if (phase === 'stop' ? senders.length === 0 : fresh === 0) return ''
  return hookOutput(phase, codexNotice(senders))
}

/** `agent-chat inbox-hook --host codex <post|prompt|stop>`: never fails the tool call. */
export async function codexInboxHook(phase: string): Promise<void> {
  try {
    const out = codexInboxHookOutput(phase, await readStdin())
    if (out !== '') process.stdout.write(`${out}\n`)
  } catch {
    // A notice lost here still surfaces at Stop, which counts every waiting record.
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
