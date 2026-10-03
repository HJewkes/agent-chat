import path from 'node:path'
import { logEvent } from '../../broker/log.js'
import { isSeatName, parseSeat, type Seat } from './charter.js'
import { appendSeatLog, readText, seatLogClock, seatLogPath } from './io.js'
import { alreadyJournaled, journalText, type JournalEntry } from './journal-line.js'
import { seatOf } from './seat-of.js'

/** CC-316: the broker writes a seat's spawn, retire, park, merged, stalled and teleport-failed lines, so the seat does not. */

/** Never throws: a journal line must not fail the spawn, retire or park that caused it. */
export type SeatJournal = (entry: JournalEntry) => void

type Log = (event: string, detail: Record<string, unknown>) => void

export interface JournalDeps {
  now?: () => Date
  log?: Log
}

const UNAVAILABLE = 'seat_journal_unavailable'
const AMBIGUOUS = 'seat_journal_ambiguous'
const REFUSED = 'seat_journal_refused'

/** Logs a problem once, and again only after it cleared. */
interface Latch {
  report: (key: string, event: string, detail: Record<string, unknown>) => void
  clear: (key: string) => void
}

function latchOver(log: Log): Latch {
  const open = new Set<string>()
  return {
    report(key, event, detail) {
      if (open.has(key)) return
      open.add(key)
      log(event, detail)
    },
    clear: key => void open.delete(key),
  }
}

/** The one seat that owns `agent`. Two seats claiming its prefix get no line, since either journal could be the wrong one. */
function ownerOf(root: string, agent: string, latch: Latch): Seat | undefined {
  const match = seatOf(root, agent)
  if (match.kind === 'none') return undefined
  const prefix = match.kind === 'seat' ? match.seat.seat.prefix : match.prefix
  const key = `${AMBIGUOUS}:${prefix}`
  if (match.kind === 'ambiguous') {
    latch.report(key, AMBIGUOUS, { prefix, seats: match.seats })
    return undefined
  }
  latch.clear(key)
  return match.seat.seat
}

/** CC-402: a seat's own successor carries the seat's name, not its prefix, so its failed teleport is found by name. */
function seatNamed(root: string, name: string): Seat | undefined {
  if (!isSeatName(name)) return undefined
  const text = readText(path.join(root, 'seats', `${name}.md`))
  return text === undefined ? undefined : parseSeat(name, text)
}

function write(root: string, entry: JournalEntry, at: Date, latch: Latch): void {
  const owner = ownerOf(root, entry.agent, latch)
  const self = owner === undefined && entry.event === 'teleport-failed' ? seatNamed(root, entry.agent) : undefined
  const seat = owner ?? self
  if (seat === undefined) return
  const text = journalText(self === undefined ? entry : { ...entry, task: '-' }, seat.prefix)
  if (text === undefined) return latch.report(REFUSED, REFUSED, { event: entry.event, agent: entry.agent })
  latch.clear(REFUSED)
  const today = readText(seatLogPath(root, seat.name, at)) ?? ''
  if (alreadyJournaled(today, `${seatLogClock(at)} ${text}`)) return
  appendSeatLog(root, seat.name, at, text)
}

/** A journal over the autonomy root at `root`; each problem is logged once, and again only after it cleared. */
export function seatJournal(root: string, deps: JournalDeps = {}): SeatJournal {
  const latch = latchOver(deps.log ?? logEvent)
  return entry => {
    try {
      write(root, entry, deps.now?.() ?? new Date(), latch)
      latch.clear(UNAVAILABLE)
    } catch (err) {
      latch.report(UNAVAILABLE, UNAVAILABLE, { reason: err instanceof Error ? err.message : String(err) })
    }
  }
}
