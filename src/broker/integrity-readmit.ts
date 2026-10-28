import { INTEGRITY_READMITTED, INTEGRITY_READMIT_SKIPPED, INTEGRITY_READMIT_SWEEP } from './event-log.js'
import type { AppendInput } from './event-store.js'
import { HUMAN_ROOT, NONCE_IN_USE, type Parent } from './integrity-ledger.js'
import type { Mismatch } from '../leak-guard/integrity/record.js'

/**
 * TP-4345 S2: the event-log record of every `Supervisor.readmit` outcome and of the start's sweep,
 * so a survivor the ledger did not enrol says why. Written as the broker, never to the human's queue.
 */
export interface ReadmitRecord {
  admitted(agentId: string, parent: Parent, armed: boolean): void
  skipped(agentId: string, reason: string): void
  sweep(sweep: ReadmitSweep): void
}

export interface ReadmitSweep {
  readonly live: number
  readonly admitted: number
  readonly skipped: readonly string[]
}

/** The skip reason for a mismatch the ledger's own `readmit` latched on. */
export function latchReason(mismatch: Mismatch, recorded: Mismatch | undefined): string {
  if (mismatch.file === NONCE_IN_USE.file && mismatch.field === NONCE_IN_USE.field) return 'nonce in use'
  return `files: ${mismatch.file}/${mismatch.field}${mismatch === recorded ? ' (on record)' : ''}`
}

const parentName = (parent: Parent): string => (parent === HUMAN_ROOT ? 'human' : parent)

/**
 * One skip row per agent and reason per broker start: a spawn under an unenrolled parent asks for
 * its re-admit on every spawn, and each reconnect of a survivor asks again.
 */
export function readmitRecorder(append: (input: AppendInput) => void): ReadmitRecord {
  const written = new Set<string>()
  const note = (event: string, body: string, meta: Record<string, string>) =>
    append({ kind: 'notice', actor: 'agent-chat', target: 'agent-chat', body, meta: { event, ...meta } })
  return {
    admitted: (agentId, parent, armed) =>
      note(INTEGRITY_READMITTED, `integrity: re-admitted ${agentId} under ${parentName(parent)}`, {
        agent_id: agentId,
        parent: parentName(parent),
        armed: String(armed),
      }),
    skipped: (agentId, reason) => {
      const key = JSON.stringify([agentId, reason])
      if (written.has(key)) return
      written.add(key)
      note(INTEGRITY_READMIT_SKIPPED, `integrity: did not re-admit ${agentId}: ${reason}`, {
        agent_id: agentId,
        reason,
      })
    },
    sweep: ({ live, admitted, skipped }) =>
      note(
        INTEGRITY_READMIT_SWEEP,
        `integrity: ${admitted} of ${live} reattached agents re-admitted, ${skipped.length} skipped`,
        {
          live: String(live),
          admitted: String(admitted),
          skipped: String(skipped.length),
          skipped_ids: skipped.join(','),
        },
      ),
  }
}
