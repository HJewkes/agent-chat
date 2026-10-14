import { DEFAULT_DISPATCH_COST, pointsSpent } from './budget-gate.js'

/** CC-1038: what one dispatch has been observed to cost a pool, from its reading history. */

/** One reading of a pool; `at` is epoch ms. */
export interface CostReading {
  at: number
  sevenDay: number
  fiveHour: number
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

const clamp = (value: number, floor: number, ceiling: number): number =>
  Math.min(ceiling, Math.max(floor, value))

/** Reset-aware rise of one window: a drop counts from zero, as `pointsSpent` reads seven_day. */
const rise = (readings: readonly CostReading[], value: (r: CostReading) => number): number =>
  pointsSpent(readings.map(r => ({ at: r.at, sevenDay: value(r) })))

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
  const fiveHourRise = rise(inWindow, r => r.fiveHour)
  const sevenDayRise = rise(inWindow, r => r.sevenDay)
  return {
    sevenDay: clamp(sevenDayRise / spawns, COST_FLOOR.sevenDay, DEFAULT_DISPATCH_COST.sevenDay),
    fiveHour: clamp(fiveHourRise / spawns, COST_FLOOR.fiveHour, DEFAULT_DISPATCH_COST.fiveHour),
    basis:
      `observed: ${spawns} spawns, +${fiveHourRise} five_hour +${sevenDayRise} seven_day` +
      ` over ${hhmm(first.at)}-${hhmm(last.at)}Z`,
  }
}
