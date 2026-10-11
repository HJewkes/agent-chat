import { heartbeatMinutes, quietLimitMs } from './heartbeat-external.js'
import { latestSlot } from './heartbeat.js'

/**
 * CC-391: the record that proves a seat's heartbeat comes from the watchdog. It reads the
 * `heartbeat_watchdog` and `heartbeat_external` rows the broker log holds, and reports where
 * deliveries stopped for longer than the cron's quiet limit and where one slot got two.
 * Pure: the rows, the holds and the window arrive as arguments.
 */

export interface DeliveryRow {
  event: string
  /** Epoch ms the row was logged. */
  at: number
  /** Epoch ms of the cron slot a watchdog row ticked for; a pause wake has none. */
  slot?: number
  /** A `heartbeat_external` row logs whether its send landed. */
  ok?: boolean
}

export interface Hold {
  fromMs: number
  toMs: number
}

export interface GapsInput {
  /** The seat's `heartbeat_cron`: it sets the quiet limit and places an external row in its slot. */
  cron: string
  rows: readonly DeliveryRow[]
  holds: readonly Hold[]
  fromMs: number
  toMs: number
}

export interface Gap {
  fromMs: number
  toMs: number
  /** Minutes of the gap outside every hold. */
  minutes: number
}

export interface DoubleDelivery {
  slot: number
  events: string[]
}

export interface GapsReport {
  deliveries: number
  limitMinutes: number
  gaps: Gap[]
  doubles: DoubleDelivery[]
}

const DELIVERY_EVENTS = new Set(['heartbeat_watchdog', 'heartbeat_external'])

const minuteMs = 60_000

const delivered = (row: DeliveryRow): boolean =>
  DELIVERY_EVENTS.has(row.event) && !(row.event === 'heartbeat_external' && row.ok === false)

function heldMs(from: number, to: number, holds: readonly Hold[]): number {
  return holds.reduce((sum, h) => sum + Math.max(0, Math.min(to, h.toMs) - Math.max(from, h.fromMs)), 0)
}

function gapsBetween(times: readonly number[], limitMs: number, holds: readonly Hold[]): Gap[] {
  return times.slice(1).flatMap((to, i) => {
    const from = times[i] ?? to
    const open = to - from - heldMs(from, to, holds)
    return open > limitMs ? [{ fromMs: from, toMs: to, minutes: Math.round(open / minuteMs) }] : []
  })
}

/** The slot a delivery answered: a watchdog row names it, an external row is placed by its time. */
const slotOf = (row: DeliveryRow, cron: string): number | undefined =>
  row.slot ?? (row.event === 'heartbeat_external' ? latestSlot(cron, row.at) : undefined)

function doublesOf(rows: readonly DeliveryRow[], cron: string): DoubleDelivery[] {
  const bySlot = new Map<number, string[]>()
  for (const row of rows) {
    const slot = slotOf(row, cron)
    if (slot !== undefined) bySlot.set(slot, [...(bySlot.get(slot) ?? []), row.event])
  }
  return [...bySlot]
    .filter(([, events]) => events.length > 1)
    .map(([slot, events]) => ({ slot, events }))
    .sort((a, b) => a.slot - b.slot)
}

export function heartbeatGaps(input: GapsInput): GapsReport {
  const minutes = heartbeatMinutes(input.cron)
  if (typeof minutes === 'string') throw new Error(minutes)
  const limitMs = quietLimitMs(minutes)
  const rows = input.rows
    .filter(row => delivered(row) && row.at >= input.fromMs && row.at <= input.toMs)
    .sort((a, b) => a.at - b.at)
  const times = [input.fromMs, ...rows.map(r => r.at), input.toMs]
  return {
    deliveries: rows.length,
    limitMinutes: Math.round(limitMs / minuteMs),
    gaps: gapsBetween(times, limitMs, input.holds),
    doubles: doublesOf(rows, input.cron),
  }
}

/** The stretch from each `HH:MM BUDGET-PAUSE ... until HH:MM` line to its reset, the next such time after the line. */
export function pauseHolds(journal: string, day: Date): Hold[] {
  return journal.split('\n').flatMap(line => {
    const m = /^(\d\d):(\d\d) BUDGET-PAUSE\b.*\buntil (\d{1,2}):(\d\d)\b/.exec(line)
    if (m === null) return []
    const fromMs = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      Number(m[1]),
      Number(m[2]),
    ).getTime()
    const reset = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(m[3]), Number(m[4]))
    if (reset.getTime() <= fromMs) reset.setDate(reset.getDate() + 1)
    return [{ fromMs, toMs: reset.getTime() }]
  })
}

const clock = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function renderGaps(seat: string, hours: number, report: GapsReport): string[] {
  const head = `${seat}: ${report.deliveries} deliveries in ${hours} h, quiet limit ${report.limitMinutes} min`
  return [
    head,
    ...report.gaps.map(g => `${seat}: GAP ${g.minutes} min, ${clock(g.fromMs)} to ${clock(g.toMs)}`),
    ...report.doubles.map(d => `${seat}: DOUBLE at slot ${clock(d.slot)}: ${d.events.join(' + ')}`),
  ]
}
