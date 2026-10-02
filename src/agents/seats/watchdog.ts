import type { BudgetRead, BudgetWindow } from '../budget.js'
import { gatePool, type AccountReading, type PoolRule, type SevenDaySample } from '../burndown/budget-gate.js'
import type { Pool, Seat, SeatSpend } from './charter.js'
import { pacedCaps } from './stops.js'

/**
 * The idle watchdog's decision (CC-203): wake a seat that has no implementer
 * running while its pool has budget and the scorer has eligible work. Pure: every
 * reading arrives as an argument, so the live run and the replay share it.
 */

/** Minutes past the hour launchd runs it: six minutes after each `17,47` heartbeat, and midway between. */
export const WATCHDOG_MINUTES = [8, 23, 38, 53] as const

export const WAKE_MESSAGE = 'Watchdog: 0 implementers, run Discovery'

/** Idle runs in a row before a wake; one idle run can be a seat between a merge and its next dispatch. */
export const FIRE_AFTER_RUNS = 2

/** Two runs further apart than this are not consecutive, e.g. across a sleep. */
export const MAX_RUN_GAP_MS = 20 * 60_000

/** Wakes with no implementer appearing before the watchdog stops until one appears. */
export const FIRE_CAP = 2

/** Two missed `17,47` heartbeats plus five minutes of slack: a seat that logged more recently is alive. */
export const SEAT_QUIET_MS = 65 * 60_000

export interface SeatAgent {
  name: string
  profile: string
  state: string
  spawnedBy: string
}

export interface BudgetVerdict {
  open: boolean
  reason: string
}

export interface Observation {
  budget: BudgetVerdict
  implementers: number
  /** Undefined when the scorer could not be read, which never counts as work. */
  eligible: number | undefined
  /** Malformed tasks the scorer skipped; a low `eligible` with skips is not a real drop. */
  skipped?: number
  /** Why the seat must not be woken now: an owner stop, a pause line, a spend stop or a restart window. */
  hold?: string
  /** Epoch ms of the seat's latest own log line; undefined when it has none. */
  activityAt?: number
}

const skippedNote = (obs: Observation): string =>
  obs.skipped === undefined || obs.skipped === 0 ? '' : `, skipped: ${obs.skipped}`

export interface SeatState {
  idleRuns: number
  /** Epoch ms of the run that wrote this state. */
  at: number
  /** Wakes since an implementer last ran. */
  fires?: number
}

export interface Decision {
  fire: boolean
  reason: string
  next: SeatState
}

const RUNNING = new Set(['spawning', 'live', 'detached'])

/** An exited agent that is not yet retired is parked (awaiting review or the owner), not working. */
export function runningImplementers(agents: SeatAgent[], seat: Pick<Seat, 'name' | 'prefix'>): string[] {
  return agents
    .filter(a => a.name.startsWith(`${seat.prefix}-`) || a.spawnedBy === seat.name)
    .filter(a => a.profile.includes('implementer') && RUNNING.has(a.state))
    .map(a => a.name)
}

const windowUsed = (window: BudgetWindow | undefined, nowMs: number): number | undefined =>
  window === undefined
    ? undefined
    : window.resets_at !== undefined && window.resets_at * 1000 <= nowMs
      ? 0
      : window.used_pct

/** A window whose reset has passed reads 0: nobody redraws a status line at 3am to say so. */
export function accountReading(read: BudgetRead, nowMs: number): AccountReading | undefined {
  if (!read.found) return undefined
  const fiveHour = windowUsed(read.budget.rate_limits.five_hour, nowMs)
  const sevenDay = windowUsed(read.budget.rate_limits.seven_day, nowMs)
  return {
    ageSeconds: read.age_seconds,
    ...(fiveHour === undefined ? {} : { fiveHour }),
    ...(sevenDay === undefined ? {} : { sevenDay }),
  }
}

/** CC-409: a pool reading that held both windows, kept in the watchdog doc so a later gap can lean on it. */
export interface PoolReading {
  /** Epoch ms the status file was written. */
  at: number
  sevenDay: number
  fiveHour: number
}

/** The reading to keep: this one when it holds both windows, else the one kept before. */
export function keepReading(
  kept: PoolReading | undefined,
  reading: AccountReading | undefined,
  nowMs: number,
): PoolReading | undefined {
  if (reading?.sevenDay === undefined || reading.fiveHour === undefined) return kept
  return { at: nowMs - reading.ageSeconds * 1000, sevenDay: reading.sevenDay, fiveHour: reading.fiveHour }
}

/** A kept reading aged to now; one missing a figure from a hand-edited doc is no reading. */
export function lastGoodReading(kept: PoolReading | undefined, nowMs: number): AccountReading | undefined {
  if (kept === undefined || ![kept.at, kept.sevenDay, kept.fiveHour].every(Number.isFinite)) return undefined
  return {
    ageSeconds: Math.round((nowMs - kept.at) / 1000),
    sevenDay: kept.sevenDay,
    fiveHour: kept.fiveHour,
  }
}

export interface PoolBudgetInput {
  pool: Pool | undefined
  spend: SeatSpend
  reading: AccountReading | undefined
  lastGood?: AccountReading | undefined
  /** The pool's seven_day readings at or before the run start and the day start. */
  history: readonly SevenDaySample[]
  runStartAt: number
  now: Date
  /** CC-404: the seat's `pacing:` and the epoch ms the pool's seven_day resets, for a reset-aware day stop. */
  pacing?: string | undefined
  resetsAt?: number | undefined
}

const poolRule = (pool: Pool): PoolRule => ({
  name: pool.name,
  human_uses: pool.humanUses,
  reserve_seven_day: pool.rule.reserve_seven_day,
  ceiling_five_hour: pool.rule.ceiling_five_hour,
  night_reserve_seven_day: pool.rule.night?.reserve_seven_day,
  per_day_points: pool.perDayPoints,
})

/** Charter section 4's budget stops for the seat, with the owner assumed present because nothing here can tell. */
export function poolBudget(input: PoolBudgetInput): BudgetVerdict {
  const { pool, spend, reading, lastGood, history, runStartAt, now } = input
  const paced = pacedCaps({
    pacing: input.pacing,
    pool: pool === undefined ? undefined : poolRule(pool),
    spend: { per_run_points: spend.perRunPoints, per_day_points: spend.perDayPoints },
    sevenDay: reading?.sevenDay,
    resetsAt: input.resetsAt,
    history,
    now,
  })
  const gate = gatePool(
    {
      pool: paced.pool,
      spend: paced.spend,
      reading,
      lastGood,
      history,
      runStartAt,
      ctx: { now },
    },
    // An idle pool's status line never redraws, and a woken seat takes its own fresh reading before it dispatches.
    { maxReadingAgeSeconds: Number.POSITIVE_INFINITY },
  )
  return { open: gate.open, reason: gate.reason }
}

const quietFor = (activityAt: number | undefined, nowMs: number): number | undefined =>
  activityAt === undefined ? undefined : nowMs - activityAt

export function decide(
  obs: Observation,
  previous: SeatState | undefined,
  nowMs: number,
  fireCap = FIRE_CAP,
): Decision {
  const fires = previous?.fires ?? 0
  const skip = (reason: string, idleRuns = 0): Decision => ({
    fire: false,
    reason,
    next: { idleRuns, at: nowMs, fires },
  })
  if (obs.implementers > 0)
    return {
      fire: false,
      reason: `${obs.implementers} implementer(s) running`,
      next: { idleRuns: 0, at: nowMs, fires: 0 },
    }
  if (obs.hold !== undefined) return skip(`held: ${obs.hold}`)
  if (!obs.budget.open) return skip(`budget closed: ${obs.budget.reason}`)
  if (obs.eligible === undefined) return skip('eligible count unavailable')
  if (obs.eligible === 0) return skip(`no eligible work${skippedNote(obs)}`)
  const quiet = quietFor(obs.activityAt, nowMs)
  if (quiet !== undefined && quiet < SEAT_QUIET_MS)
    return skip(`seat alive: logged ${Math.round(quiet / 60_000)} min ago`)
  if (fires >= fireCap) return skip(`fire cap: ${fires} wake(s) with no implementer; waiting for a dispatch`)
  const consecutive = previous !== undefined && nowMs - previous.at <= MAX_RUN_GAP_MS
  const idleRuns = (consecutive ? previous.idleRuns : 0) + 1
  const summary = `0 implementers, budget open (${obs.budget.reason}), ${obs.eligible} eligible${skippedNote(obs)}`
  if (idleRuns < FIRE_AFTER_RUNS)
    return skip(`${summary}; idle run ${idleRuns} of ${FIRE_AFTER_RUNS}`, idleRuns)
  return {
    fire: true,
    reason: summary,
    next: { idleRuns: 0, at: nowMs, fires: fires + 1 },
  }
}
