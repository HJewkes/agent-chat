import type { Pool, Seat } from './charter.js'

/**
 * Why the watchdog holds a seat it would otherwise wake (CC-203 review): the
 * charter's spend stops, the seat's own pause line, and an open restart window.
 * Pure: the live run reads the disk and passes what it read.
 */

/** Seven_day points spent since `since`, accumulated run over run from the pool's reading. */
export interface SpendMeter {
  since: number
  last: number
  spent: number
}

/** The charter's run is at most 12 hours; the watchdog cannot see the owner's messages that start one. */
export const RUN_CAP_MS = 12 * 3_600_000

/** A restart announcement with no "restart done" is ignored after this, so a lost reply cannot park every seat. */
export const RESTART_WINDOW_MAX_MS = 2 * 3_600_000

const DAY_START_HOUR = 7

/** The charter's spend day runs from 07:00 local to 07:00 local. */
export function spendDay(at: number): string {
  const d = new Date(at - DAY_START_HOUR * 3_600_000)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

export const sameSpendDay = (meter: SpendMeter, nowMs: number): boolean =>
  spendDay(meter.since) === spendDay(nowMs)

export const withinRun = (meter: SpendMeter, nowMs: number): boolean => nowMs - meter.since < RUN_CAP_MS

/** A drop in seven_day is a window reset; the points spent just before it are lost, so it counts nothing. */
export function advanceMeter(
  previous: SpendMeter | undefined,
  sevenDay: number | undefined,
  nowMs: number,
  current: (meter: SpendMeter, nowMs: number) => boolean,
): SpendMeter | undefined {
  if (sevenDay === undefined) return previous
  if (previous === undefined || !current(previous, nowMs)) return { since: nowMs, last: sevenDay, spent: 0 }
  return {
    since: previous.since,
    last: sevenDay,
    spent: previous.spent + Math.max(0, sevenDay - previous.last),
  }
}

/** Charter section 4: the day stop is the lower of the pool's and the seat's `per_day_points`. */
export function spendStop(
  seat: Pick<Seat, 'spend'>,
  pool: Pick<Pool, 'name' | 'perDayPoints'> | undefined,
  day: SpendMeter | undefined,
  run: SpendMeter | undefined,
): string | undefined {
  const caps = [pool?.perDayPoints, seat.spend.perDayPoints].filter((n): n is number => n !== undefined)
  const dayCap = caps.length === 0 ? undefined : Math.min(...caps)
  if (day !== undefined && dayCap !== undefined && day.spent >= dayCap)
    return `per_day_points stop: pool ${pool?.name ?? '?'} spent ${day.spent} of ${dayCap} since 07:00`
  const runCap = seat.spend.perRunPoints
  if (run !== undefined && runCap !== undefined && run.spent >= runCap)
    return `per_run_points stop: ${run.spent} of ${runCap} spent this run`
  return undefined
}

/** A seat log line the seat wrote itself, as the charter's `HH:MM <text>`; the watchdog's own lines are not the seat's. */
interface SeatLine {
  at: number
  text: string
}

function seatLines(log: string, day: Date): SeatLine[] {
  return log.split('\n').flatMap(line => {
    const m = /^(\d\d):(\d\d) (.*)$/.exec(line)
    if (m === null || m[3]?.startsWith('Watchdog:')) return []
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(m[1]), Number(m[2]))
    return [{ at: at.getTime(), text: m[3] ?? '' }]
  })
}

export interface LogVerdict {
  /** Set when the seat's latest line is a `BUDGET-PAUSE` or `PARKED` line. */
  stop?: string
  /** Epoch ms of the seat's latest line. */
  activityAt?: number
}

/** Reads the seat's log for local day `day`: its latest line decides whether it parked itself. */
export function readSeatLog(log: string, day: Date): LogVerdict {
  const latest = seatLines(log, day).reduce<SeatLine | undefined>(
    (best, line) => (best === undefined || line.at >= best.at ? line : best),
    undefined,
  )
  if (latest === undefined) return {}
  const marker = /^(BUDGET-PAUSE|PARKED)\b/.test(latest.text)
  return { activityAt: latest.at, ...(marker ? { stop: `seat logged "${latest.text.slice(0, 80)}"` } : {}) }
}

export interface OwnerMessage {
  ts: number
  body: string
}

const ANNOUNCE = /restart at \d{1,2}:\d\d|broker restart now/i
const DONE = /restart done/i

/** Charter cross-seat protocol 5: seats hold from the owner seat's announcement until its "restart done". */
export function restartWindow(messages: OwnerMessage[], nowMs: number): string | undefined {
  const sorted = [...messages].filter(m => m.ts <= nowMs).sort((a, b) => a.ts - b.ts)
  const announced = sorted.findLast(m => ANNOUNCE.test(m.body))
  if (announced === undefined || nowMs - announced.ts > RESTART_WINDOW_MAX_MS) return undefined
  if (sorted.some(m => m.ts >= announced.ts && DONE.test(m.body))) return undefined
  return `restart window open since ${new Date(announced.ts).toISOString().slice(11, 16)}Z`
}
