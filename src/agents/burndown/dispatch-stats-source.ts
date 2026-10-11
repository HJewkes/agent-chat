import path from 'node:path'
import { burndownLedgerPath, burndownTickStatusPath, burndownTicksPath, home } from '../../paths.js'
import type { DispatchRecord } from '../seats/dispatch-record.js'
import { isSeatName, parseSeat } from '../seats/charter.js'
import { dispatchLogPath } from '../seats/dispatch-log.js'
import { readSeatJournal, readText, seatFileNames } from '../seats/io.js'
import type { DispatchStatsPorts } from './dispatch-stats.js'
import { readLedger } from './ledger.js'
import { loadResolvedConfig } from './settings-store.js'
import { readWasteObservations } from './waste-source.js'
import { readTickStatus } from './tick-status.js'
import type { VerdictObservation } from './waste.js'

/** CC-933: `dispatch-stats`' ports over this machine's agent-chat home and the autonomy root at `root`. */
export function dispatchStatsPorts(root: string, now: Date): DispatchStatsPorts {
  return {
    now,
    seats: () => seatFileNames(root),
    tickRows: () => readText(burndownTicksPath()),
    ledger: () => readLedger(burndownLedgerPath()),
    dispatchLog: seat => seatDispatchLog(root, seat),
    journal: (seat, day) => readSeatJournal(root, seat, day),
    lastOkAt: () => readTickStatus(burndownTickStatusPath()).lastOkAt,
    maxAgents: () => loadResolvedConfig().tick.maxAgents,
    verdicts: (runs, sinceMs) => readVerdicts(runs, sinceMs, now),
  }
}

function seatDispatchLog(root: string, seat: string): string | undefined {
  const text = isSeatName(seat) ? readText(path.join(root, 'seats', `${seat}.md`)) : undefined
  const parsed = text === undefined ? undefined : parseSeat(seat, text)
  if (text === undefined || parsed === undefined) return undefined
  const file = dispatchLogPath(root, { seat: parsed, text })
  return file === undefined ? undefined : readText(file)
}

/** The verdicts on the runs' PRs, via the waste detectors' reader; a task's seat is not needed to find them. */
function readVerdicts(runs: readonly DispatchRecord[], sinceMs: number, now: Date): VerdictObservation[] {
  const tasks = [...new Set(runs.flatMap(r => r.task ?? []))].map(task => ({ task, seat: '' }))
  const obs = readWasteObservations(path.join(home(), 'events.db'), {
    tasks,
    dispatches: runs,
    window: { startMs: sinceMs, endMs: now.getTime() },
  })
  if ('error' in obs) throw new Error(obs.error)
  return obs.verdicts
}
