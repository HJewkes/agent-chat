import type { BudgetRead, BudgetWindow } from '../budget.js'
import { gateAccount, type AccountReading } from '../burndown/budget-gate.js'
import type { Pool, Seat } from './charter.js'

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

/** Wakes with no implementer appearing before the watchdog stops until the seat shows activity again. */
export const FIRE_CAP = 2

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
  /** Why the seat must not be woken now: an owner stop, a pause line, a spend stop or a restart window. */
  hold?: string
  /** Epoch ms of the seat's latest own log line. */
  activityAt?: number
}

export interface SeatState {
  idleRuns: number
  /** Epoch ms of the run that wrote this state. */
  at: number
  /** Wakes since the seat last showed activity. */
  fires?: number
  lastFireAt?: number
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

/** Charter section 4's window stops, with the owner assumed present because nothing here can tell. */
export function poolBudget(
  pool: Pool | undefined,
  reading: AccountReading | undefined,
  now: Date,
): BudgetVerdict {
  const gate = gateAccount(pool?.name ?? 'unknown pool', pool?.rule, reading, { now })
  return { open: gate.open, reason: gate.reason }
}

type FireCount = Pick<SeatState, 'fires' | 'lastFireAt'>

const minuteOf = (ms: number): number => ms - (ms % 60_000)

/** Seat log lines carry only HH:MM, so a line in the wake's own minute counts as activity after it. */
function firesSinceActivity(previous: SeatState | undefined, activityAt: number | undefined): FireCount {
  const { fires, lastFireAt } = previous ?? {}
  if (fires === undefined || lastFireAt === undefined) return { fires: 0 }
  if (activityAt !== undefined && activityAt >= minuteOf(lastFireAt)) return { fires: 0 }
  return { fires, lastFireAt }
}

export function decide(
  obs: Observation,
  previous: SeatState | undefined,
  nowMs: number,
  fireCap = FIRE_CAP,
): Decision {
  const count = firesSinceActivity(previous, obs.activityAt)
  const skip = (reason: string, idleRuns = 0): Decision => ({
    fire: false,
    reason,
    next: { idleRuns, at: nowMs, ...count },
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
  if (obs.eligible === 0) return skip('no eligible work')
  const fires = count.fires ?? 0
  if (fires >= fireCap)
    return skip(`fire cap: ${fires} wake(s) with no implementer; waiting for a dispatch or a seat log line`)
  const consecutive = previous !== undefined && nowMs - previous.at <= MAX_RUN_GAP_MS
  const idleRuns = (consecutive ? previous.idleRuns : 0) + 1
  const summary = `0 implementers, budget open (${obs.budget.reason}), ${obs.eligible} eligible`
  if (idleRuns < FIRE_AFTER_RUNS)
    return skip(`${summary}; idle run ${idleRuns} of ${FIRE_AFTER_RUNS}`, idleRuns)
  return {
    fire: true,
    reason: summary,
    next: { idleRuns: 0, at: nowMs, fires: fires + 1, lastFireAt: nowMs },
  }
}
