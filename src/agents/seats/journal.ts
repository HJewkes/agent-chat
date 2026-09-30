import fs from 'node:fs'
import path from 'node:path'
import { logEvent } from '../../broker/log.js'
import { isSeatName, parseSeat, type Seat } from './charter.js'
import { appendSeatLog, readText, seatLogClock, seatLogPath } from './io.js'
import { alreadyJournaled, journalText, type JournalEntry } from './journal-line.js'

/** CC-316: the broker writes a seat's spawn, retire, park, merged and stalled lines, so the seat does not. */

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

/** Every seat whose file declares a prefix `agent` is named with; read fresh, so a new seat needs no restart. */
function seatsOf(root: string, agent: string): Seat[] {
  const dir = path.join(root, 'seats')
  return fs
    .readdirSync(dir)
    .filter(file => file.endsWith('.md'))
    .map(file => file.slice(0, -'.md'.length))
    .filter(isSeatName)
    .flatMap(name => parseSeat(name, readText(path.join(dir, `${name}.md`)) ?? '') ?? [])
    .filter(seat => agent.startsWith(`${seat.prefix}-`))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The one seat that owns `agent`. Two seats claiming it get no line, since either journal could be the wrong one. */
function ownerOf(root: string, agent: string, latch: Latch): Seat | undefined {
  const seats = seatsOf(root, agent)
  const [first] = seats
  if (first === undefined) return undefined
  const key = `${AMBIGUOUS}:${first.prefix}`
  if (seats.length > 1) {
    latch.report(key, AMBIGUOUS, { prefix: first.prefix, seats: seats.map(seat => seat.name) })
    return undefined
  }
  latch.clear(key)
  return first
}

function write(root: string, entry: JournalEntry, at: Date, latch: Latch): void {
  const seat = ownerOf(root, entry.agent, latch)
  if (seat === undefined) return
  const text = journalText(entry, seat.prefix)
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
