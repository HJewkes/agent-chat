import os from 'node:os'
import path from 'node:path'
import { meterSpend, type SavedMeters, type SpendMeter } from '../seats/stops.js'
import { daySpend, dayStart, spendSince, type SevenDaySample } from './budget-gate.js'
import type { SeatState } from './ledger.js'
import { expandHome } from './seat-dispatch.js'

/**
 * CC-1099: the one spend meter. The tick, the broker spawn gate, `seats status` and the watchdog pass
 * build their `gatePool` history here, so one seat's run and day spend reads the same in all four.
 */

/** Covers the 07:00 day start and the 12-hour run, with slack for a late tick. */
export const SAMPLE_KEEP_MS = 26 * 3_600_000

// CC-1118: the tick keys the ledger by the charter's raw `~/` string while `parsePools` expands it.
const samePoolDir = (a: string, b: string, home: string): boolean =>
  path.resolve(expandHome(a, home)) === path.resolve(expandHome(b, home))

/**
 * The seat's ledger samples read from this pool's account within the keep window. CC-1080: a drop
 * across pools is a different account's reading, not a seven_day reset, and an unkeyed ledger's
 * samples are unknowable, so both read as none.
 */
export function poolSamples(
  state: SeatState | undefined,
  configDir: string,
  nowMs: number,
  home: string = os.homedir(),
): SevenDaySample[] {
  if (state?.configDir === undefined || !samePoolDir(state.configDir, configDir, home)) return []
  return state.samples.filter(s => s.at > nowMs - SAMPLE_KEEP_MS && s.at < nowMs)
}

export interface SeatSpendInput {
  /** The seat's burndown ledger state; absent, the watchdog meters stand alone. */
  seatState: SeatState | undefined
  /** The config dir of the pool being metered, which the ledger samples must have been read from. */
  configDir: string
  /** The watchdog's saved run meter for the seat and day meter for the pool. */
  saved: SavedMeters
  sevenDay: number | undefined
  now: Date
  /** False for a pool the seat does not own: its run meter stays out of the history. */
  ownRun?: boolean
  /** The home a `~/` config dir expands against; defaults to the process's. */
  home?: string
}

export interface SeatSpend {
  history: SevenDaySample[]
  runStart: number
  source: 'ledger' | 'meters'
  /** Spend since the run start and since 07:00; undefined with no reading or no baseline. */
  run: number | undefined
  day: number | undefined
  /** The pool's day meter advanced to this reading. */
  dayMeter: SpendMeter | undefined
}

/**
 * The ledger's samples when they hold a reading at or before the run start, else the watchdog meters
 * alone. Never both: a meter's samples are estimates that never drop, so sorted among real readings
 * across a seven_day reset, `pointsSpent` would count the pre-reset readings again.
 */
export function seatSpend(input: SeatSpendInput): SeatSpend {
  const { sevenDay, now } = input
  const kept = poolSamples(input.seatState, input.configDir, now.getTime(), input.home)
  const meters = meterSpend(input.saved, sevenDay, now, input.ownRun ?? true)
  // With no current reading the meters still stand behind the last good one (CC-409) when the ledger cannot.
  const useMeters = !kept.some(s => s.at <= meters.runStart) && meters.history.length > 0
  const history = useMeters ? meters.history : kept
  const current = sevenDay === undefined ? undefined : { at: now.getTime(), sevenDay }
  return {
    history,
    runStart: meters.runStart,
    source: useMeters ? 'meters' : 'ledger',
    run: current === undefined ? undefined : spendSince(history, meters.runStart, current),
    day: current === undefined ? undefined : daySpend(history, dayStart(now), current)?.points,
    dayMeter: meters.day,
  }
}
