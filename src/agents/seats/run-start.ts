import type { BudgetRead } from '../budget.js'
import { MAX_READING_AGE_SECONDS } from '../burndown/budget-gate.js'
import { charterSeats, isSeatName, parsePools, parseSeat, type Pool } from './charter.js'
import type { SeatRecord, WatchdogDoc } from './io.js'
import type { RunLock } from './lock.js'
import type { SpendMeter } from './stops.js'
import { accountReading } from './watchdog.js'

/**
 * CC-472: the owner's message to a seat starts a new run (charter section 4). The watchdog only
 * rolls a run over after 12 hours, so this resets the seat's run meter by hand, under the
 * watchdog's own run lock so neither write loses the other's.
 */

export type RunStartCode = 'unknown_seat' | 'no_reading' | 'lock_held'

export class RunStartRefused extends Error {
  constructor(
    readonly code: RunStartCode,
    message: string,
  ) {
    super(`${code}: ${message}`)
  }
}

/** Longer than a watchdog run normally holds the lock; a run stuck past it is refused, not waited out. */
export const RUN_START_LOCK_WAIT_MS = 90_000
const LOCK_POLL_MS = 500

export interface RunStartDeps {
  now: () => Date
  readCharter: () => string | undefined
  readSeatFile: (seat: string) => string | undefined
  readBudget: (configDir: string, nowMs: number) => BudgetRead
  /** Throws when seat-watchdog.json is there and unusable, which refuses with that error. */
  loadDoc: () => WatchdogDoc
  saveDoc: (doc: Omit<WatchdogDoc, 'stopped'>) => void
  lock: () => RunLock
  sleep: (ms: number) => Promise<void>
  lockWaitMs?: number
}

export interface RunStarted {
  seat: string
  pool: string
  meter: SpendMeter
  previous: SpendMeter | undefined
}

function seatPool(deps: RunStartDeps, name: string): Pool {
  const charter = deps.readCharter()
  if (charter === undefined) throw new RunStartRefused('unknown_seat', 'no charter.md under the root')
  if (!isSeatName(name) || !charterSeats(charter).includes(name))
    throw new RunStartRefused('unknown_seat', `${name} is not a seat in the charter`)
  const seat = parseSeat(name, deps.readSeatFile(name) ?? '')
  if (seat === undefined) throw new RunStartRefused('unknown_seat', `seats/${name}.md has no prefix or pool`)
  const pool = parsePools(charter).get(seat.pool)
  if (pool === undefined)
    throw new RunStartRefused('unknown_seat', `${name}'s pool ${seat.pool} is not a charter pool`)
  return pool
}

/** The pool's seven_day now, from a status file no older than the spawn gate accepts. */
function currentSevenDay(deps: RunStartDeps, pool: Pool, nowMs: number): number {
  const reading = accountReading(deps.readBudget(pool.configDir, nowMs), nowMs)
  if (reading?.sevenDay === undefined)
    throw new RunStartRefused('no_reading', `pool ${pool.name} has no seven_day reading`)
  if (reading.ageSeconds < 0 || reading.ageSeconds > MAX_READING_AGE_SECONDS)
    throw new RunStartRefused(
      'no_reading',
      `pool ${pool.name}'s reading is ${reading.ageSeconds}s old, over the ${MAX_READING_AGE_SECONDS}s limit`,
    )
  return reading.sevenDay
}

async function heldLock(deps: RunStartDeps): Promise<Extract<RunLock, { held: true }>> {
  const deadline = deps.now().getTime() + (deps.lockWaitMs ?? RUN_START_LOCK_WAIT_MS)
  for (;;) {
    const lock = deps.lock()
    if (lock.held) return lock
    if (deps.now().getTime() >= deadline) throw new RunStartRefused('lock_held', lock.reason)
    await deps.sleep(LOCK_POLL_MS)
  }
}

const usable = (meter: SpendMeter | undefined): SpendMeter | undefined =>
  [meter?.since, meter?.last, meter?.spent].every(Number.isFinite) ? meter : undefined

/** Only this seat's `run` changes; a seat the watchdog never saw gets the state of a first run. */
function withRun(
  doc: WatchdogDoc,
  seat: string,
  meter: SpendMeter,
  nowMs: number,
): Omit<WatchdogDoc, 'stopped'> {
  const record: SeatRecord = { ...(doc.seats[seat] ?? { idleRuns: 0, at: nowMs }), run: meter }
  return {
    seats: { ...doc.seats, [seat]: record },
    pools: doc.pools,
    ...(doc.lastReadings === undefined ? {} : { lastReadings: doc.lastReadings }),
    ...(doc.held === undefined ? {} : { held: doc.held }),
  }
}

/** Sets `seat`'s run meter to a run starting now; writes nothing when it refuses. */
export async function startRun(deps: RunStartDeps, seat: string): Promise<RunStarted> {
  const pool = seatPool(deps, seat)
  const lock = await heldLock(deps)
  try {
    const nowMs = deps.now().getTime()
    const sevenDay = currentSevenDay(deps, pool, nowMs)
    const doc = deps.loadDoc()
    const previous = usable(doc.seats[seat]?.run)
    const meter: SpendMeter = {
      since: nowMs,
      last: sevenDay,
      spent: 0,
      ...(previous === undefined ? {} : { before: previous.last }),
    }
    deps.saveDoc(withRun(doc, seat, meter, nowMs))
    return { seat, pool: pool.name, meter, previous }
  } finally {
    lock.release()
  }
}

const hhmm = (at: number): string => `${new Date(at).toISOString().slice(11, 16)}Z`

export function renderRunStart(started: RunStarted): string[] {
  const { meter, previous } = started
  const was =
    previous === undefined
      ? 'no saved run meter'
      : `run since ${hhmm(previous.since)} with ${previous.spent} points spent`
  return [
    `${started.seat}: run started at ${hhmm(meter.since)} on pool ${started.pool}, seven_day ${meter.last}%, 0 points spent (was ${was})`,
  ]
}
