import path from 'node:path'
import { burndownLedgerPath, burndownTickStatusPath, burndownTicksPath } from '../../paths.js'
import { isSeatName, parseSeat } from '../seats/charter.js'
import { dispatchLogPath } from '../seats/dispatch-log.js'
import { readSeatJournal, readText, seatFileNames } from '../seats/io.js'
import type { DispatchStatsPorts } from './dispatch-stats.js'
import { readLedger } from './ledger.js'
import { readTickStatus } from './tick-status.js'

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
  }
}

function seatDispatchLog(root: string, seat: string): string | undefined {
  const text = isSeatName(seat) ? readText(path.join(root, 'seats', `${seat}.md`)) : undefined
  const parsed = text === undefined ? undefined : parseSeat(seat, text)
  if (text === undefined || parsed === undefined) return undefined
  const file = dispatchLogPath(root, { seat: parsed, text })
  return file === undefined ? undefined : readText(file)
}
