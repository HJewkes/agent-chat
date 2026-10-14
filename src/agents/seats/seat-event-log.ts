import fs from 'node:fs'
import path from 'node:path'
import { foldSeatEvents, seatEventSchema, type SeatEvent, type SeatState } from '@titan-design/coordinator'

/**
 * TP-1600 a: a seat's event log, `logs/<seat>/seat-events.jsonl`. The broker appends one coordinator
 * SeatEvent (plus `at`) per row; the successor's state is the coordinator fold over those rows.
 */

export interface SeatStateRead {
  state: SeatState
  /** Lines that were not JSON objects; the fold never saw them. */
  corruptLines: number
}

interface Row {
  at: string
  event: Record<string, unknown>
}

const SEAT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function seatEventsPath(root: string, seat: string): string {
  if (!SEAT_NAME.test(seat) || seat.includes('..')) throw new Error(`invalid seat name: ${seat}`)
  return path.join(root, 'logs', seat, 'seat-events.jsonl')
}

/** Throws on an event `seatEventSchema` refuses, so a bad row never reaches the log. */
export function appendSeatEvent(root: string, seat: string, event: SeatEvent, at: string): void {
  const parsed = seatEventSchema.parse(event)
  const file = seatEventsPath(root, seat)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify({ ...parsed, at })}\n`)
}

function readRows(root: string, seat: string): { rows: Row[]; corruptLines: number } {
  let text: string
  try {
    text = fs.readFileSync(seatEventsPath(root, seat), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { rows: [], corruptLines: 0 }
    throw err
  }
  const rows: Row[] = []
  let corruptLines = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const value: unknown = JSON.parse(line)
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error('not an object')
      const { at, ...event } = value as Record<string, unknown>
      rows.push({ at: typeof at === 'string' ? at : '', event })
    } catch {
      corruptLines += 1
    }
  }
  return { rows, corruptLines }
}

/** A missing log folds to the empty state. `tmpdir` is passed to the fold, which refuses background watches under it. */
export function readSeatState(root: string, seat: string, options: { tmpdir?: string } = {}): SeatStateRead {
  const { rows, corruptLines } = readRows(root, seat)
  const state = foldSeatEvents(
    rows.map(r => r.event),
    options.tmpdir === undefined ? {} : { tmpdir: options.tmpdir },
  )
  return { state, corruptLines }
}

/** The `at` of the last teleport row, or undefined when the seat has never teleported. */
export function lastTeleportAt(root: string, seat: string): string | undefined {
  const { rows } = readRows(root, seat)
  return rows.findLast(row => row.event.kind === 'teleport' && row.at !== '')?.at
}
