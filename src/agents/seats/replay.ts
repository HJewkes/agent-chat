import type { AgentEventRow } from '../../broker/event-store.js'
import type { AgentIdentity } from '../../protocol.js'
import type { AccountReading } from '../burndown/budget-gate.js'
import { foldAgent, groupByAgent } from '../identity.js'
import type { Pool, Seat } from './charter.js'
import {
  WATCHDOG_MINUTES,
  decide,
  poolBudget,
  runningImplementers,
  type SeatAgent,
  type SeatState,
} from './watchdog.js'

/** A past day, rebuilt from events.db and timed budget readings, run through the same decision. */

export interface TimedReading {
  at: number
  fiveHour?: number
  sevenDay?: number
}

export interface ReplayRow {
  at: number
  implementers: string[]
  fire: boolean
  reason: string
}

/** The non-retired roster at `at`, folded exactly as the broker folds it for `agent ls`. */
export function agentsAt(rows: readonly AgentEventRow[], at: number): SeatAgent[] {
  const groups = groupByAgent(rows.filter(row => row.ts <= at))
  return [...groups.values()]
    .map(group => foldAgent(group))
    .filter((agent): agent is AgentIdentity => agent !== undefined && agent.state !== 'retired')
    .map(({ name, profile, state, spawnedBy }) => ({ name, profile, state, spawnedBy }))
}

/** Each window carries forward from its own latest reading; nothing before the first reading is known. */
export function readingAt(readings: TimedReading[], at: number): AccountReading | undefined {
  const seen = readings.filter(r => r.at <= at).sort((a, b) => a.at - b.at)
  const fiveHour = seen.findLast(r => r.fiveHour !== undefined)
  const sevenDay = seen.findLast(r => r.sevenDay !== undefined)
  if (fiveHour === undefined && sevenDay === undefined) return undefined
  const newest = Math.max(fiveHour?.at ?? 0, sevenDay?.at ?? 0)
  return {
    ageSeconds: Math.round((at - newest) / 1000),
    ...(fiveHour?.fiveHour === undefined ? {} : { fiveHour: fiveHour.fiveHour }),
    ...(sevenDay?.sevenDay === undefined ? {} : { sevenDay: sevenDay.sevenDay }),
  }
}

/** `2026-09-29T05:53:53Z=39/19`; either side of the slash may be empty. */
export function parseReadingFlag(flag: string): TimedReading {
  const m = /^(.+)=(\d*)\/(\d*)$/.exec(flag)
  const at = m?.[1] === undefined ? Number.NaN : Date.parse(m[1])
  if (m === null || !Number.isFinite(at))
    throw new Error(`--reading wants <ISO time>=<five_hour>/<seven_day>, got "${flag}"`)
  return {
    at,
    ...(m[2] === '' || m[2] === undefined ? {} : { fiveHour: Number(m[2]) }),
    ...(m[3] === '' || m[3] === undefined ? {} : { sevenDay: Number(m[3]) }),
  }
}

/** Log lines in the charter's `HH:MM <text>` form that quote both windows, on local date `day`. */
export function parseLogReadings(log: string, day: string): TimedReading[] {
  const found = log.split('\n').map(line => /^(\d\d):(\d\d) .*five_hour (\d+)%.*seven_day (\d+)%/.exec(line))
  return found.flatMap(m =>
    m === null
      ? []
      : [
          {
            at: new Date(`${day}T${m[1]}:${m[2]}:00`).getTime(),
            fiveHour: Number(m[3]),
            sevenDay: Number(m[4]),
          },
        ],
  )
}

/** Every watchdog run time on UTC day `day` (`YYYY-MM-DD`). */
export function runTimes(day: string): number[] {
  const start = Date.parse(`${day}T00:00:00Z`)
  if (!Number.isFinite(start)) throw new Error(`--replay wants YYYY-MM-DD, got "${day}"`)
  return Array.from({ length: 24 }, (_, hour) =>
    WATCHDOG_MINUTES.map(minute => start + hour * 3_600_000 + minute * 60_000),
  ).flat()
}

export interface ReplayInput {
  seat: Seat
  pool: Pool | undefined
  events: AgentEventRow[]
  readings: TimedReading[]
  /** The scorer reads today's tasks, so a past day's count is an assumption the caller states. */
  eligible: number | undefined
}

export function replay(input: ReplayInput, times: number[]): ReplayRow[] {
  let state: SeatState | undefined
  return times.map(at => {
    const implementers = runningImplementers(agentsAt(input.events, at), input.seat)
    const budget = poolBudget(input.pool, readingAt(input.readings, at), new Date(at))
    const decision = decide(
      { budget, implementers: implementers.length, eligible: input.eligible },
      state,
      at,
    )
    state = decision.next
    return { at, implementers, fire: decision.fire, reason: decision.reason }
  })
}
