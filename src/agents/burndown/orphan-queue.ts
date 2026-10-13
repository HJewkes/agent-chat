import { readySlices, type Ledger } from './ledger.js'

/**
 * CC-1226 (dispatch self-heal H2, class D19): a seat that holds `queued` claims but has no plan this tick never
 * dispatches them. The tick runs only the seats it is configured for, so slices seeded for another seat wait in
 * silence. This names that seat; it moves nothing, because turning the seat on is an owner decision.
 */

export interface OrphanQueue {
  seat: string
  queued: number
  /** Queued slices whose dependencies are met, by `readySlices`. */
  ready: number
  oldestMinutes: number
}

const MINUTE_MS = 60_000

/** One entry per seat, in seat-name order, that holds queued claims and is not in `ticked`. */
export function orphanQueues(ledger: Ledger, ticked: ReadonlySet<string>, now: Date): OrphanQueue[] {
  const ready = new Set(readySlices(ledger).map(c => `${c.taskId}\0${c.slice ?? ''}`))
  const bySeat = new Map<string, OrphanQueue>()
  for (const c of ledger.claims) {
    if (c.phase !== 'queued' || c.seat === undefined || ticked.has(c.seat)) continue
    const age = Math.max(0, Math.round((now.getTime() - Date.parse(c.phaseAt)) / MINUTE_MS))
    const entry = bySeat.get(c.seat) ?? { seat: c.seat, queued: 0, ready: 0, oldestMinutes: 0 }
    entry.queued += 1
    if (ready.has(`${c.taskId}\0${c.slice ?? ''}`)) entry.ready += 1
    if (Number.isFinite(age)) entry.oldestMinutes = Math.max(entry.oldestMinutes, age)
    bySeat.set(c.seat, entry)
  }
  return [...bySeat.values()].sort((a, b) => a.seat.localeCompare(b.seat))
}

export const orphanQueueLine = (o: OrphanQueue): string =>
  `orphan queue: seat ${o.seat} not ticked, ${o.queued} queued (${o.ready} ready), oldest ${o.oldestMinutes}m`
