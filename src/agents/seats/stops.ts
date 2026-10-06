import {
  RUN_CAP_MS,
  dayStart,
  runStartAt,
  sevenDayLine,
  spendSince,
  type PoolRule,
  type SevenDaySample,
  type SpendCaps,
} from '../burndown/budget-gate.js'
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

export interface MeterSpend {
  history: SevenDaySample[]
  runStart: number
  run: SpendMeter | undefined
  day: SpendMeter | undefined
}

/**
 * The saved run and day meters advanced to this reading, as `gatePool` history. The tick, the spawn gate
 * and `seats status` all count spend through this. `ownRun` false keeps the run meter out of the history
 * (a pool the seat does not own) while the run start still follows it.
 */
export function meterSpend(
  saved: { run?: SpendMeter | undefined; day?: SpendMeter | undefined },
  sevenDay: number | undefined,
  now: Date,
  ownRun = true,
): MeterSpend {
  const nowMs = now.getTime()
  const run =
    ownRun && saved.run !== undefined ? advanceMeter(saved.run, sevenDay, nowMs, withinRun) : undefined
  const day = saved.day === undefined ? undefined : advanceMeter(saved.day, sevenDay, nowMs, sameSpendDay)
  const runStart = runStartAt(now, saved.run === undefined ? {} : { recordedAt: saved.run.since })
  const starts = [
    { at: runStart, meter: run },
    { at: dayStart(now), meter: day },
  ]
  return { history: meterHistory(starts, nowMs), runStart, run, day }
}

const DAY_MS = 24 * 3_600_000

export interface DayAllowanceInput {
  /** The seat file's `pacing:`; only `reset-aware` changes the day stop. */
  pacing: unknown
  reserveSevenDay: number | undefined
  /** The day caps the charter and the seat file set, which stand when reset-aware pacing cannot apply. */
  perDayPoints: readonly (number | undefined)[]
  sevenDay: number | undefined
  /** Seven_day points spent since the spend day started; undefined when no reading at or before 07:00 is known. */
  daySpend: number | undefined
  /** Epoch ms the pool's seven_day window resets. */
  resetsAt: number | undefined
  /** Epoch ms the spend day started (07:00 local). */
  dayStartMs: number
  nowMs: number
}

/** The day stop and what it was computed from; `points` is null when no day cap applies. */
export interface DayAllowance {
  source: 'reset-aware' | 'per_day_points'
  points: number | null
  stopLine: number | null
  sevenDay: number | null
  /** The seven_day the allowance spreads from: at the day start, or the current one when that is unknown. */
  dayStartSevenDay: number | null
  basis: 'day-start' | 'current'
  daysToReset: number | null
  resetsAt: string | null
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/** CC-404: a `reset-aware` seat may spend what is left above its stop line spread over the days to the reset. */
export function dayAllowance(input: DayAllowanceInput): DayAllowance {
  const { reserveSevenDay, sevenDay, daySpend, resetsAt, nowMs } = input
  const caps = input.perDayPoints.filter((cap): cap is number => cap !== undefined)
  const basis: DayAllowance['basis'] =
    sevenDay !== undefined && daySpend !== undefined ? 'day-start' : 'current'
  const dayStartSevenDay = sevenDay === undefined ? undefined : sevenDay - (daySpend ?? 0)
  // Headroom, line and days share one anchor, so the allowance holds steady through the day.
  const anchor = basis === 'day-start' ? input.dayStartMs : nowMs
  const stopLine = reserveSevenDay === undefined ? null : sevenDayLine(reserveSevenDay, resetsAt, anchor).line
  const days = resetsAt === undefined ? undefined : (resetsAt - anchor) / DAY_MS
  const inputs = {
    stopLine,
    sevenDay: sevenDay ?? null,
    dayStartSevenDay: dayStartSevenDay ?? null,
    basis,
    daysToReset: days === undefined ? null : round2(days),
    resetsAt: resetsAt === undefined ? null : new Date(resetsAt).toISOString(),
  }
  const paced = input.pacing === 'reset-aware' && stopLine !== null && dayStartSevenDay !== undefined
  if (!paced || days === undefined || resetsAt === undefined || resetsAt <= nowMs)
    return { source: 'per_day_points', points: caps.length === 0 ? null : Math.min(...caps), ...inputs }
  const points = Math.max(0, (stopLine - dayStartSevenDay) / days)
  return { source: 'reset-aware', points: round2(points), ...inputs }
}

export interface PacingInput {
  /** The seat file's `pacing:`. */
  pacing: unknown
  pool: PoolRule | undefined
  spend: SpendCaps
  sevenDay: number | undefined
  /** Epoch ms the pool's seven_day window resets. */
  resetsAt: number | undefined
  /** The pool's earlier seven_day readings, as `gatePool` reads them. */
  history: readonly SevenDaySample[]
  now: Date
}

export interface PacedCaps {
  pool: PoolRule | undefined
  spend: SpendCaps
  allowance: DayAllowance
}

/** CC-404: the caps every gate hands `gatePool`, so status, the watchdog and the tick hold a seat at one day stop. */
export function pacedCaps(input: PacingInput): PacedCaps {
  const { pool, spend, sevenDay, now } = input
  const start = dayStart(now)
  const nowMs = now.getTime()
  const daySpend =
    sevenDay === undefined ? undefined : spendSince(input.history, start, { at: nowMs, sevenDay })
  const allowance = dayAllowance({
    pacing: input.pacing,
    reserveSevenDay: pool?.reserve_seven_day,
    perDayPoints: [pool?.per_day_points, spend.per_day_points],
    sevenDay,
    daySpend,
    resetsAt: input.resetsAt,
    dayStartMs: start,
    nowMs,
  })
  if (allowance.source !== 'reset-aware' || pool === undefined || allowance.points === null)
    return { pool, spend, allowance }
  // CC-474: gatePool lifts the seat's caps on days 6-7, so the pool's own day cap must stay on the pool.
  if (sevenDayLine(pool.reserve_seven_day ?? 0, input.resetsAt, nowMs).capsLifted)
    return { pool, spend, allowance }
  return {
    pool: { ...pool, per_day_points: undefined },
    spend: { ...spend, per_day_points: allowance.points, per_day_label: "seat's reset-aware day allowance" },
    allowance,
  }
}

/** A seat log line the seat wrote itself, as the charter's `HH:MM <text>`; the watchdog's and the broker's lines are not the seat's. */
interface SeatLine {
  at: number
  text: string
}

// CC-463: a relaunch line counted as activity would mask the relaunch failing.
const isWatchdogText = (text: string): boolean =>
  text.startsWith('Watchdog:') || text.startsWith('watchdog relaunch ')

function seatLines(log: string, day: Date): SeatLine[] {
  return log.split('\n').flatMap(line => {
    const m = /^(\d\d):(\d\d) (.*)$/.exec(line)
    if (m === null || isWatchdogText(m[3] ?? '') || isJournalText(m[3] ?? '')) return []
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

export const DEFAULT_MACHINE_STOP_MEMORY_FREE_PERCENT = 20
export const DEFAULT_MACHINE_STOP_LOAD5 = 28
export const DEFAULT_MACHINE_STOP_SWAP_USED_PERCENT = 60
export const DEFAULT_MACHINE_STOP_PRESSURE_LEVEL = 2

export interface MachineStopLimits {
  /** Stop below this share of memory free. */
  memoryFreePercent: number
  /** Stop above this five-minute load average. */
  load5: number
  /** Stop above this share of swap used; null disables the swap trigger. */
  swapUsedPercent: number | null
  /** Stop at or above this kernel memory pressure level (1 normal, 2 warn, 4 critical). */
  pressureLevel: number
}

/** A reading that could not be taken is null, and a null reading never stops a seat. */
export interface MachineStopReadings {
  memoryFreePercent: number | null
  load5: number | null
  swapUsedPercent: number | null
  pressureLevel: number | null
}

export interface MachineStop extends MachineStopReadings {
  /** The breach in words, with the readings that caused it. */
  reason: string
}

/** CC-431, CC-492: a machine under memory, swap, pressure level or load holds every seat; each breach names its reading. */
export function machineStop(readings: MachineStopReadings, limits: MachineStopLimits): MachineStop | null {
  const { memoryFreePercent, load5, swapUsedPercent, pressureLevel } = readings
  const breaches = [
    ...(memoryFreePercent !== null && memoryFreePercent < limits.memoryFreePercent
      ? [`memory ${memoryFreePercent}% free (floor ${limits.memoryFreePercent}%)`]
      : []),
    ...(swapUsedPercent !== null &&
    limits.swapUsedPercent !== null &&
    swapUsedPercent > limits.swapUsedPercent
      ? [`swap ${swapUsedPercent}% used (limit ${limits.swapUsedPercent}%)`]
      : []),
    ...(pressureLevel !== null && pressureLevel >= limits.pressureLevel
      ? [`pressure level ${pressureLevel} (limit ${limits.pressureLevel})`]
      : []),
    ...(load5 !== null && load5 > limits.load5 ? [`load5 ${load5} (limit ${limits.load5})`] : []),
  ]
  if (breaches.length === 0) return null
  return {
    memoryFreePercent,
    load5,
    swapUsedPercent,
    pressureLevel,
    reason: `machine under pressure: ${breaches.join(', ')}`,
  }
}
