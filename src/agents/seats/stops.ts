import { RUN_CAP_MS, dayStart, type SevenDaySample } from '../burndown/budget-gate.js'
import { isJournalText } from './journal-line.js'

/**
 * Why the watchdog holds a seat it would otherwise wake (CC-203 review): the
 * seat's own pause line and an open restart window. The spend stops are `gatePool`'s;
 * this file keeps the meters that give it the run-start and day-start readings.
 * Pure: the live run reads the disk and passes what it read.
 */

/** Seven_day points spent since `since`, accumulated run over run from the pool's reading. */
export interface SpendMeter {
  since: number
  last: number
  spent: number
  /** The reading of the meter this one replaced, taken before this window began. */
  before?: number
}

/** A restart announcement with no "restart done" is ignored after this, so a lost reply cannot park every seat. */
export const RESTART_WINDOW_MAX_MS = 2 * 3_600_000

/** Both meters start where the shared convention says a run and a spend day start. */
export const sameSpendDay = (meter: SpendMeter, nowMs: number): boolean =>
  meter.since >= dayStart(new Date(nowMs))

export const withinRun = (meter: SpendMeter, nowMs: number): boolean => nowMs - meter.since < RUN_CAP_MS

/** A drop in seven_day is a window reset; the points spent just before it are lost, so it counts nothing. */
export function advanceMeter(
  previous: SpendMeter | undefined,
  sevenDay: number | undefined,
  nowMs: number,
  current: (meter: SpendMeter, nowMs: number) => boolean,
): SpendMeter | undefined {
  if (sevenDay === undefined) return previous
  if (previous === undefined) return { since: nowMs, last: sevenDay, spent: 0 }
  if (!current(previous, nowMs)) return { since: nowMs, last: sevenDay, spent: 0, before: previous.last }
  return {
    since: previous.since,
    last: sevenDay,
    spent: previous.spent + Math.max(0, sevenDay - previous.last),
    ...(previous.before === undefined ? {} : { before: previous.before }),
  }
}

export interface MeterStart {
  at: number
  meter: SpendMeter | undefined
}

/**
 * The meters as `gatePool` history, each dated at its window's start. A meter's first sample may come
 * after that start; the reading it replaced then stands at the start, and with none the window counts
 * from the first sample. The chain never drops, so two meters that disagree overcount the earlier window.
 */
export function meterHistory(starts: readonly MeterStart[], nowMs: number): SevenDaySample[] {
  const latestFirst = starts
    .flatMap(({ at, meter }) => {
      if (meter === undefined) return []
      // gatePool reads only samples before now, and a meter started this pass still holds its window's opening reading.
      const opening = { at: Math.min(at, nowMs - 1), sevenDay: meter.last - meter.spent }
      if (meter.before === undefined || meter.since <= at) return [opening]
      return [
        { at: Math.min(meter.since, nowMs - 1), sevenDay: opening.sevenDay },
        { at, sevenDay: meter.before },
      ]
    })
    .sort((a, b) => b.at - a.at)
  const chain: SevenDaySample[] = []
  let floor = Number.POSITIVE_INFINITY
  for (const sample of latestFirst) {
    floor = Math.min(floor, sample.sevenDay)
    chain.unshift({ at: sample.at, sevenDay: floor })
  }
  return chain
}

/** A seat log line the seat wrote itself, as the charter's `HH:MM <text>`; the watchdog's and the broker's lines are not the seat's. */
interface SeatLine {
  at: number
  text: string
}

function seatLines(log: string, day: Date): SeatLine[] {
  return log.split('\n').flatMap(line => {
    const m = /^(\d\d):(\d\d) (.*)$/.exec(line)
    if (m === null || m[3]?.startsWith('Watchdog:') || isJournalText(m[3] ?? '')) return []
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(m[1]), Number(m[2]))
    return [{ at: at.getTime(), text: m[3] ?? '' }]
  })
}

export interface LogVerdict {
  /** Set when the seat's latest line is a `BUDGET-PAUSE`, `PARKED` or `WRAP` line. */
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
  const marker = /^(BUDGET-PAUSE|PARKED|WRAP)\b/.test(latest.text)
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
