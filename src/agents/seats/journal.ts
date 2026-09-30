import fs from 'node:fs'
import path from 'node:path'
import { logEvent } from '../../broker/log.js'
import { isSeatName, parseSeat, type Seat } from './charter.js'
import { appendSeatLog, readText, seatLogClock, seatLogPath } from './io.js'
import { alreadyJournaled, journalText, type JournalEntry } from './journal-line.js'

/** CC-316: the broker writes a seat's spawn, retire, park, merged and stalled lines, so the seat does not. */

/** Never throws: a journal line must not fail the spawn, retire or park that caused it. */
export type SeatJournal = (entry: JournalEntry) => void

export interface JournalDeps {
  now?: () => Date
  log?: (event: string, detail: Record<string, unknown>) => void
}

/** The seat whose file declares the prefix `agent` is named with; read fresh, so a new seat needs no restart. */
function seatOf(root: string, agent: string): Seat | undefined {
  const dir = path.join(root, 'seats')
  return fs
    .readdirSync(dir)
    .filter(file => file.endsWith('.md'))
    .map(file => file.slice(0, -'.md'.length))
    .filter(isSeatName)
    .flatMap(name => parseSeat(name, readText(path.join(dir, `${name}.md`)) ?? '') ?? [])
    .find(seat => agent.startsWith(`${seat.prefix}-`))
}

function write(root: string, entry: JournalEntry, at: Date): void {
  const seat = seatOf(root, entry.agent)
  if (seat === undefined) return
  const today = readText(seatLogPath(root, seat.name, at)) ?? ''
  if (alreadyJournaled(today, seatLogClock(at), entry)) return
  appendSeatLog(root, seat.name, at, journalText(entry, seat.prefix))
}

/** A journal over the autonomy root at `root`; a root it cannot use is logged once and skipped after. */
export function seatJournal(root: string, deps: JournalDeps = {}): SeatJournal {
  const log = deps.log ?? logEvent
  let reported = false
  return entry => {
    try {
      write(root, entry, deps.now?.() ?? new Date())
    } catch (err) {
      if (reported) return
      reported = true
      log('seat_journal_unavailable', { reason: err instanceof Error ? err.message : String(err) })
    }
  }
}
