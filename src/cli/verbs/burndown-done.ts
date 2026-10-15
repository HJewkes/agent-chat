import path from 'node:path'
import { burndownLedgerPath } from '../../paths.js'
import { logEvent } from '../../broker/log.js'
import {
  LEDGER_WAIT_MS,
  readLedger,
  withLedgerLock,
  writeLedger,
  type Claim,
  type LockWait,
} from '../../agents/burndown/ledger.js'
import { retireNames, type RetireCall } from './burndown-release.js'
import type { Report } from '../command.js'

/**
 * CC-1225: a slice whose work was done and verified outside git has no PR to merge, so the tick never finishes
 * it. `done` finishes it by hand so its dependents dispatch, without `release` (which re-dispatches the slice)
 * or `link` (which needs a PR). The evidence path and the event row make each use auditable.
 */

export interface DonePorts {
  retire: RetireCall
  exists: (file: string) => boolean
  now?: Date
  wait?: LockWait
}

type Verdict = { refused: string } | { claim: Claim }

const refusedReport = (message: string): Report => ({ ok: false, lines: [], errors: [message] })

const FINISHABLE: ReadonlySet<Claim['phase']> = new Set(['implementing', 'queued'])

export async function finishSlice(
  task: string,
  slice: string,
  evidence: string,
  ports: DonePorts,
): Promise<Report> {
  const proof = path.resolve(evidence)
  const now = ports.now ?? new Date()
  const file = burndownLedgerPath()
  const locked = await withLedgerLock(
    file,
    (): Verdict => {
      const ledger = readLedger(file)
      const held = ledger.claims.find(c => c.taskId === task && c.slice === slice && c.phase !== 'done')
      const verdict = doneVerdict(held, `${task} slice ${slice}`, proof, ports)
      if ('refused' in verdict) return verdict
      const done = finished(verdict.claim, proof, now)
      writeLedger(file, { ...ledger, claims: ledger.claims.map(c => (c === verdict.claim ? done : c)) })
      logEvent('burndown_slice_finished_by_hand', { task, slice, from: verdict.claim.phase, evidence: proof })
      return verdict
    },
    { wait: ports.wait ?? { waitMs: LEDGER_WAIT_MS }, announce: true },
  )
  if (!locked.ran) return refusedReport(`a tick holds the ledger lock (pid ${locked.holder}); try again`)
  const verdict = locked.value
  if ('refused' in verdict) return refusedReport(verdict.refused)
  const retired = await retireNames(verdict.claim, ports.retire)
  return {
    ok: true,
    lines: [`finished ${task} slice ${slice} (was ${verdict.claim.phase}); evidence ${proof}`, ...retired],
  }
}

function doneVerdict(claim: Claim | undefined, what: string, proof: string, ports: DonePorts): Verdict {
  if (claim === undefined) return { refused: `no held claim on ${what}` }
  if (claim.pr !== undefined)
    return { refused: `${what} has PR ${claim.pr}; it finishes when that merges (or release it)` }
  if (!FINISHABLE.has(claim.phase))
    return {
      refused: `${what} is ${claim.phase}; only an implementing or queued slice can be finished by hand`,
    }
  if (!ports.exists(proof)) return { refused: `evidence ${proof} does not exist` }
  return { claim }
}

function finished(claim: Claim, proof: string, now: Date): Claim {
  const {
    stalledReason: _reason,
    stalledClass: _class,
    stallCode: _code,
    stalledAt: _at,
    stale: _stale,
    finding: _finding,
    lease: _lease,
    checkpoint: _checkpoint,
    ...kept
  } = claim
  return {
    ...kept,
    phase: 'done',
    phaseAt: now.toISOString(),
    lastReport: `finished by hand; evidence ${proof}`,
  }
}
