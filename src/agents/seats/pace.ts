import { MAX_READING_AGE_SECONDS, type AccountReading } from '../burndown/budget-gate.js'

/**
 * CC-605: where a pool stands against a straight glide from its window start to the day 7 line
 * one day before the reset. Pure: one reading, the pool's reserve and the clock.
 */

const DAY_MS = 86_400_000
const WINDOW_MS = 7 * DAY_MS
/** The glide ends this long before the reset, so the last day is slack. */
const FINISH_EARLY_MS = DAY_MS
const MIN_DAYS_LEFT = 1 / 24

export const BEHIND_AT = 5
export const BURN_AT = 10
export const AT_RISK_NEEDS = 28

export type PaceLevel = 'on_pace' | 'behind' | 'burn' | 'at_risk'

export interface PaceInput {
  sevenDay: number
  /** Epoch ms the reading's seven_day window resets. */
  resetsAt: number
}

export interface Pace {
  /** 0 when the reading's window has passed: the figure belonged to last week. */
  sevenDay: number
  target: number
  behind: number
  /** Points a day to reach the day 7 line by the glide's end. */
  needs: number
  level: PaceLevel
  /** Epoch ms of the next reset, rolled forward when the reading's has passed. */
  resetsAt: number
  /** The reading's reset has passed, so `sevenDay` is assumed and not read. */
  rolled: boolean
}

const levelOf = (behind: number, needs: number): PaceLevel =>
  needs > AT_RISK_NEEDS ? 'at_risk' : behind >= BURN_AT ? 'burn' : behind >= BEHIND_AT ? 'behind' : 'on_pace'

const nextReset = (resetsAt: number, nowMs: number): number =>
  resetsAt > nowMs ? resetsAt : resetsAt + Math.ceil((nowMs - resetsAt + 1) / WINDOW_MS) * WINDOW_MS

export function paceOf(reading: PaceInput, reserve: number, nowMs: number): Pace {
  const resetsAt = nextReset(reading.resetsAt, nowMs)
  const rolled = resetsAt !== reading.resetsAt
  const sevenDay = rolled ? 0 : reading.sevenDay
  const start = resetsAt - WINDOW_MS
  const goalAt = resetsAt - FINISH_EARLY_MS
  const day = Math.min(7, Math.floor((nowMs - start) / DAY_MS) + 1)
  const line = 100 - (reserve * (8 - day)) / 7
  const final = 100 - reserve / 7
  const target = Math.min(line, final, (final * (nowMs - start)) / (goalAt - start))
  const daysLeft = (goalAt > nowMs ? goalAt - nowMs : resetsAt - nowMs) / DAY_MS
  const needs = Math.max(0, final - sevenDay) / Math.max(daysLeft, MIN_DAYS_LEFT)
  const behind = target - sevenDay
  return { sevenDay, target, behind, needs, level: levelOf(behind, needs), resetsAt, rolled }
}

/** One pool's row in `pace.json` and in the `pace` block of `seats status`. */
export interface PoolPace {
  pool: string
  sevenDay: number | null
  fiveHour: number | null
  /** Seconds since the reading was written; null with no reading. */
  ageSeconds: number | null
  /** Over 15 minutes old, or from a window that has since reset: never a figure to decide on. */
  stale: boolean
  /** Epoch ms of the next seven_day reset. */
  resetsAt: number | null
  target: number | null
  behind: number | null
  needs: number | null
  level: PaceLevel | 'stale' | 'no_reading'
}

const round1 = (n: number): number => Math.round(n * 10) / 10

const noReading = (pool: string, reading: AccountReading | undefined): PoolPace => ({
  pool,
  sevenDay: reading?.sevenDay ?? null,
  fiveHour: reading?.fiveHour ?? null,
  ageSeconds: reading?.ageSeconds ?? null,
  stale: true,
  resetsAt: null,
  target: null,
  behind: null,
  needs: null,
  level: 'no_reading',
})

/** A reading with no seven_day figure or no reset time cannot be paced, so it is no reading. */
export function poolPace(
  pool: string,
  reading: AccountReading | undefined,
  reserve: number,
  nowMs: number,
): PoolPace {
  if (reading?.sevenDay === undefined || reading.sevenDayResetsAt === undefined)
    return noReading(pool, reading)
  const pace = paceOf({ sevenDay: reading.sevenDay, resetsAt: reading.sevenDayResetsAt }, reserve, nowMs)
  const stale = pace.rolled || reading.ageSeconds > MAX_READING_AGE_SECONDS
  return {
    pool,
    sevenDay: pace.sevenDay,
    fiveHour: reading.fiveHour ?? null,
    ageSeconds: reading.ageSeconds,
    stale,
    resetsAt: pace.resetsAt,
    target: round1(pace.target),
    behind: round1(pace.behind),
    needs: round1(pace.needs),
    level: stale ? 'stale' : pace.level,
  }
}

const span = (ms: number): string => `${Math.floor(ms / DAY_MS)}d ${Math.floor((ms % DAY_MS) / 3_600_000)}h`

/** The PACE line `bin/pace` prints, from a row. */
export function paceLine(row: PoolPace, nowMs: number): string {
  if (row.target === null || row.resetsAt === null) return `${row.pool}: no reading`
  const behind = (row.behind ?? 0) >= 0.5 ? `behind ${Math.round(row.behind ?? 0)}` : 'on pace'
  const age = `reading ${Math.floor((row.ageSeconds ?? 0) / 60)} min old${row.stale ? ' STALE' : ''}`
  return (
    `${row.pool}: ${row.sevenDay} | target ${Math.round(row.target)} | ${behind} | ` +
    `needs ${(row.needs ?? 0).toFixed(1)}/day | 5h ${row.fiveHour ?? '?'} | ` +
    `resets in ${span(row.resetsAt - nowMs)} | ${age}`
  )
}
