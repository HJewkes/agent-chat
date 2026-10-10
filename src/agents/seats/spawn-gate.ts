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

/** CC-932: how a hand spawn of a claimed or brief-ready task is treated; `refuse` is the owner's later flip. */
export const SEAT_SPAWN_MODES = ['off', 'warn', 'refuse'] as const
export type SeatSpawnMode = (typeof SEAT_SPAWN_MODES)[number]

export const SEAT_SPAWN_OVERLAP = 'seat_spawn_overlap'
export type SeatOverlapRefusalCode = typeof SEAT_SPAWN_OVERLAP

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

/** The one `override` a spawner may state; a fix round on a claimed task is the seat's own work. */
export const FIX_ROUND_OVERRIDE = 'fix-round'

/** Work roles that never overlap burndown's implementer: reading, planning and a fix round. */
const PASSING_ROLES = /^(?:reviewer|shepherd-review|planner|fix-round-\d+)$/

export interface OverlapClaim {
  /** The agent the claim waits on, else the seat that dispatched it. */
  holder?: string | undefined
}

export interface SpawnOverlapInput {
  mode: SeatSpawnMode
  /** The spawn's work role, stated or inferred. */
  role: string
  override?: string | undefined
  /** The task the spawn runs: the request's own id, else the one its name carries. */
  task?: string | undefined
  /** The non-done burndown claims on `task`. */
  claims: OverlapClaim[]
  /** The `brief:ready=<day>` day on `task`, when it carries one. */
  briefReady?: string | undefined
}

export interface SpawnOverlap {
  task: string
  holder: string
  reason: string
}

/** CC-932: what a hand spawn collides with; undefined when it may proceed whatever the mode. Pure. */
export function spawnOverlap(input: SpawnOverlapInput): SpawnOverlap | undefined {
  const { mode, role, task, claims, briefReady } = input
  if (mode === 'off' || task === undefined) return undefined
  if (input.override === FIX_ROUND_OVERRIDE || PASSING_ROLES.test(role)) return undefined
  const [claim] = claims
  if (claim !== undefined) {
    const holder = claim.holder ?? 'burndown'
    return {
      task,
      holder,
      reason: `${SEAT_SPAWN_OVERLAP}: task ${task} holds a burndown claim held by ${holder}; the tick owns it`,
    }
  }
  if (briefReady === undefined) return undefined
  const holder = `brief:ready=${briefReady}`
  return {
    task,
    holder,
    reason: `${SEAT_SPAWN_OVERLAP}: task ${task} is brief-ready (${holder}); burndown dispatches it`,
  }
}
