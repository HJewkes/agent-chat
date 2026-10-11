import type { AppendInput, EventStore } from './event-store.js'

/**
 * CC-811: notices and messages to the human close as aged out after this long.
 *
 * Written rather than derived (unlike CC-173's plain-notice TTL): the close is an
 * ordinary `resolution` row, so every reader that already honours CLOSED, the
 * digest ledger, the mirror's `closed` frames and `isOpen`, agrees without a
 * second copy of the rule, and history records when and why each item left.
 * Questions, approvals and endorsements are other kinds and never match; kinded
 * notices (`meta.kind`) stay open because each still asks the human to act and
 * the broker cannot see whether that action is still pending.
 */
export const AGE_OUT_MS = 7 * 24 * 3_600_000
export const AGED_OUT = 'aged-out'
export const AGE_OUT_SWEEP_MS = 3_600_000

interface AgeOutTarget {
  readonly events: Pick<EventStore, 'agedOutCandidates'>
  append(input: AppendInput): unknown
}

/** One sweep: closes every candidate at or before `now - AGE_OUT_MS`. Returns the msg ids it closed. */
export function sweepAgedOut(core: AgeOutTarget, now = Date.now()): string[] {
  const closed = core.events.agedOutCandidates(now - AGE_OUT_MS)
  for (const msgId of closed) {
    core.append({
      kind: 'resolution',
      actor: 'broker',
      ref: msgId,
      body: AGED_OUT,
      meta: { status: AGED_OUT },
    })
  }
  return closed
}

/** Sweeps now and then on an unref'd interval. Returns its cancel. */
export function startAgeOutSweep(core: AgeOutTarget, intervalMs = AGE_OUT_SWEEP_MS): () => void {
  const sweep = () => {
    try {
      sweepAgedOut(core)
    } catch {
      // A failed sweep must never take the broker down; the next one retries.
    }
  }
  sweep()
  const timer = setInterval(sweep, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
