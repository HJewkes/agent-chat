import { INTEGRITY_WOULD_DENY } from './event-log.js'
import type { AppendInput } from './event-store.js'
import type { CheckResult } from './integrity-ledger.js'

/**
 * TP-4347: a `shadow` ledger's record of a refusal `enforce` would make. It goes to the event log
 * as the broker, never to the human's queue, and nothing is denied.
 */

/** Where the refusal would have been made. */
export type IntegrityCall = 'spawn' | 'resume' | 'teleport' | 'mode switch' | 'hook' | 'relaunch'

export interface WouldDeny {
  /** '' when the ledger cannot name the agent, as for a hook nonce it never minted. */
  readonly agentId: string
  readonly reason: string
  readonly call: IntegrityCall
}

export type NoteWouldDeny = (deny: WouldDeny) => void

/**
 * One row per agent, call site and reason per broker start: the hook asks on every tool call, so a
 * latched agent would otherwise write a row per call.
 */
export function wouldDenyWriter(
  append: (input: AppendInput) => void,
  nameOf: (agentId: string) => string | undefined,
): NoteWouldDeny {
  const written = new Set<string>()
  return ({ agentId, reason, call }) => {
    const key = JSON.stringify([agentId, call, reason])
    if (written.has(key)) return
    written.add(key)
    const agent = nameOf(agentId) ?? agentId
    append({
      kind: 'notice',
      actor: 'agent-chat',
      target: 'agent-chat',
      body: `integrity (shadow): would deny ${call} for ${agent || 'an unknown launch'}: ${reason}`,
      meta: { event: INTEGRITY_WOULD_DENY, agent, agent_id: agentId, call, reason },
    })
  }
}

/** A ledger refusal as one line: its reason, and the file, field and principal when it names them. */
export function verdictReason(result: Exclude<CheckResult, { ok: true }>): string {
  if (result.reason === 'no baseline') return result.reason
  const under = result.reason === 'quarantined' ? ` under ${result.principal}` : ''
  return `${result.reason}: ${result.file} (${result.field})${under}`
}
