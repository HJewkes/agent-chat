import {
  MAX_READING_AGE_SECONDS,
  gatePool,
  runStartAt,
  type AccountReading,
  type FullReading,
  type PoolRule,
  type SevenDaySample,
  type SpendCaps,
} from '../burndown/budget-gate.js'
import type { Pool, Seat } from './charter.js'
import { meterSpend, pacedCaps, type SpendMeter } from './stops.js'
import { poolRule } from './watchdog.js'

/**
 * CC-288: charter section 4's budget stops for a seat-prefixed spawn, run on the pool the spawn bills.
 * Pure: the broker reads the charter, the status file and the watchdog's meters and passes them in.
 */

export const SEAT_BUDGET_STOP = 'seat_budget_stop'
export type SeatBudgetRefusalCode = typeof SEAT_BUDGET_STOP

export interface SeatSpawnInput {
  seat: Seat
  /** The charter pool whose config_dir the spawn resolved to; an overflow spawn bills one that is not the seat's. */
  pool: Pool
  reading: AccountReading | undefined
  /** Epoch ms the pool's seven_day window resets. */
  resetsAt?: number | undefined
  /** The watchdog's saved run meter for the seat; it meters the seat's own pool only. */
  runMeter?: SpendMeter | undefined
  /** The watchdog's saved day meter for the billed pool. */
  dayMeter?: SpendMeter | undefined
  /** The spawn profile's model. */
  model: string
  now: Date
  /** Epoch ms of the owner's last typed turn; absent reads as the owner present, as every other gate does. */
  humanLastTurnAt?: number | undefined
}

export interface SeatSpawnVerdict {
  allow: boolean
  reason: string
}

const isFresh = (reading: AccountReading | undefined): reading is FullReading =>
  reading?.sevenDay !== undefined &&
  reading.fiveHour !== undefined &&
  reading.ageSeconds >= 0 &&
  reading.ageSeconds <= MAX_READING_AGE_SECONDS

const missing = (reading: AccountReading | undefined): string =>
  reading?.sevenDay === undefined || reading.fiveHour === undefined
    ? 'no seven_day and five_hour reading'
    : `reading is ${reading.ageSeconds}s old, over the ${MAX_READING_AGE_SECONDS}s limit`

export const isSonnet = (model: string): boolean => /sonnet/i.test(model)

interface SpendHistory {
  history: SevenDaySample[]
  runStart: number
  hasRun: boolean
  hasDay: boolean
}

/** The saved meters advanced to this reading, as `seats status` advances them, so both count the same spend. */
function spendHistory(input: SeatSpawnInput, sevenDay: number, own: boolean): SpendHistory {
  const { now, runMeter, dayMeter } = input
  const spend = meterSpend({ run: runMeter, day: dayMeter }, sevenDay, now, own)
  return {
    history: spend.history,
    runStart: spend.runStart,
    hasRun: spend.run !== undefined,
    hasDay: spend.day !== undefined,
  }
}

/** The caps `gatePool` checks; a cap whose meter was never saved is unknown spend, which CC-409 never pauses on. */
function spawnCaps(
  input: SeatSpawnInput,
  own: boolean,
  spend: SpendHistory,
): { pool: PoolRule; spend: SpendCaps } {
  const { seat, pool } = input
  const rule = poolRule(pool)
  const paced = pacedCaps({
    pacing: own ? seat.pacing : undefined,
    pool: rule,
    spend: {
      per_run_points: own && spend.hasRun ? seat.spend.perRunPoints : undefined,
      per_day_points: own ? seat.spend.perDayPoints : undefined,
    },
    sevenDay: input.reading?.sevenDay,
    resetsAt: input.resetsAt,
    history: spend.history,
    now: input.now,
  })
  const caps = { pool: paced.pool ?? rule, spend: paced.spend }
  if (spend.hasDay) return caps
  return {
    pool: { ...caps.pool, per_day_points: undefined },
    spend: { ...caps.spend, per_day_points: undefined },
  }
}

/** Allows on a missing or stale reading; refuses past a stop, and opus inside the pool's sonnet band. */
export function seatSpawnGate(input: SeatSpawnInput): SeatSpawnVerdict {
  const { seat, pool, reading, now } = input
  const who = `seat ${seat.name}`
  if (!isFresh(reading))
    return { allow: true, reason: `${who}, pool ${pool.name}: ${missing(reading)}, so no stop applies` }
  const own = seat.pool === pool.name
  const spend = spendHistory(input, reading.sevenDay, own)
  const caps = spawnCaps(input, own, spend)
  const gate = gatePool({
    ...caps,
    reading,
    history: spend.history,
    runStartAt: spend.runStart,
    ctx: { now, ...(input.humanLastTurnAt === undefined ? {} : { humanLastTurnAt: input.humanLastTurnAt }) },
  })
  if (!gate.open) return { allow: false, reason: `${who}: ${gate.reason}` }
  if (gate.sonnetOnly && !isSonnet(input.model))
    return { allow: false, reason: `${who}: ${gate.reason}; profile model ${input.model} is not sonnet` }
  return { allow: true, reason: `${who}: ${gate.reason}` }
}
