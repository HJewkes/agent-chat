import { DEFAULT_DISPATCH_COST, pointsSpent } from './budget-gate.js'

/** CC-1038: what one dispatch has been observed to cost a pool, from its reading history. */

/** One reading of a pool; `at` is epoch ms. */
export interface CostReading {
  at: number
  sevenDay: number
  fiveHour: number
  /** Epoch ms the seven_day window resets; absent when unknown. */
  sevenDayResetsAt?: number
}

export interface ObservedDispatchCost {
  sevenDay: number
  fiveHour: number
  /** Where the figure came from, for the gate's reason. */
  basis: string
}

export const COST_WINDOW_MS = 5 * 3_600_000
/** A spawn newer than this has not spent yet, so it is left out of the count. */
export const SPEND_LAG_MS = 15 * 60_000
export const MIN_COST_SPAWNS = 10
export const MIN_COST_SPAN_MS = 60 * 60_000
/** A charge never reaches zero, however quiet the pool looked. */
export const COST_FLOOR = { sevenDay: 0.05, fiveHour: 0.25 }
/** The watchdog's seven_day reading wobbles by a point between readers, so a smaller drop is not a reset. */
export const SEVEN_DAY_RESET_DROP = 5

const clamp = (value: number, floor: number, ceiling: number): number =>
  Math.min(ceiling, Math.max(floor, value))

/** Reset-aware five_hour rise: any drop counts from zero, as `pointsSpent` reads it. */
const fiveHourRise = (readings: readonly CostReading[]): number =>
  pointsSpent(readings.map(r => ({ at: r.at, sevenDay: r.fiveHour })))

/**
 * Seven_day rise over the high-water mark. A drop is a reset only when the prior reading's resets_at has passed
 * or the fall from the mark reaches SEVEN_DAY_RESET_DROP; a smaller dip and its recovery add nothing.
 */
function sevenDayRise(readings: readonly CostReading[]): number {
  let total = 0
  let level = readings[0]?.sevenDay ?? 0
  for (const [i, cur] of readings.entries()) {
    const prev = readings[i - 1]
    if (prev === undefined) continue
    const windowPassed = prev.sevenDayResetsAt !== undefined && prev.sevenDayResetsAt <= cur.at
    if (windowPassed || level - cur.sevenDay >= SEVEN_DAY_RESET_DROP) {
      total += cur.sevenDay
      level = cur.sevenDay
    } else {
      total += Math.max(0, cur.sevenDay - level)
      level = Math.max(level, cur.sevenDay)
    }
  }
  return total
}

const hhmm = (ms: number): string => new Date(ms).toISOString().slice(11, 16)

/**
 * The pool's rise over the trailing window divided by the spawns billed to it, each window clamped to
 * [floor, DEFAULT_DISPATCH_COST]; undefined when the window holds too few spawns or too short a span of readings.
 */
export function observedDispatchCost(
  readings: readonly CostReading[],
  spawnTimes: readonly number[],
  nowMs: number,
): ObservedDispatchCost | undefined {
  const inWindow = readings
    .filter(r => r.at > nowMs - COST_WINDOW_MS && r.at <= nowMs)
    .sort((a, b) => a.at - b.at)
  const first = inWindow[0]
  const last = inWindow.at(-1)
  if (!first || !last || last.at - first.at < MIN_COST_SPAN_MS) return undefined
  const spawnEnd = nowMs - SPEND_LAG_MS
  const spawns = spawnTimes.filter(t => t > spawnEnd - COST_WINDOW_MS && t <= spawnEnd).length
  if (spawns < MIN_COST_SPAWNS) return undefined
  const fiveHour = fiveHourRise(inWindow)
  const sevenDay = sevenDayRise(inWindow)
  return {
    sevenDay: clamp(sevenDay / spawns, COST_FLOOR.sevenDay, DEFAULT_DISPATCH_COST.sevenDay),
    fiveHour: clamp(fiveHour / spawns, COST_FLOOR.fiveHour, DEFAULT_DISPATCH_COST.fiveHour),
    basis:
      `observed: ${spawns} spawns, +${fiveHour} five_hour +${sevenDay} seven_day` +
      ` over ${hhmm(first.at)}-${hhmm(last.at)}Z`,
  }
}
