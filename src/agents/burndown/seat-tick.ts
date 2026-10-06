import { readAccountBudget } from '../budget.js'
import { loadDoc } from '../seats/io.js'
import { meterSpend, pacedCaps, type SpendMeter } from '../seats/stops.js'
import { accountReading } from '../seats/watchdog.js'
import { chargesOn, runStartAt, type PoolGateInput, type SevenDaySample } from './budget-gate.js'
import { sameTickCollision, type SameTickClaim } from './collision.js'
import type { Initiative, Refusal, Task } from './eligibility.js'
import { isLive, occupantOf } from '../isolation/sweep.js'
import type { Claim, Ledger, SeatState } from './ledger.js'
import { rowNamed, type Roster } from './observe.js'
import type { Capacity, Dispatch, PlanInputs } from './plan.js'
import { loadPolicy, mergeDefaults, seatBudget, seatScope, type Policy, type SeatPolicy } from './policy.js'
import { scoreAll } from './score.js'
import { readScoredTasks } from './score-source.js'
import { resolveSeatDispatch, type SeatDispatch } from './seat-dispatch.js'
import { planSeat, type OrderInputs } from './seat-plan.js'
import { describeError, readWeekMilestones, taskIdsOnDisk } from './score-render.js'
import { readTasks } from './source.js'

/**
 * CC-205 slice 4: seats mode for one tick. Loads the policy once, samples each
 * enabled seat's pool, and plans its dispatches with `planSeat`. A seat that
 * cannot be loaded or planned is skipped with a reason; the others still run.
 * CLI-only.
 */

/** Covers the 07:00 day start and the 12-hour run, with slack for a late tick. */
export const SAMPLE_KEEP_MS = 26 * 3_600_000

export interface SeatTickDeps {
  autonomyRoot: string
  /** The active-work root, for briefs and tasks. */
  root: string
  now: Date
  /** The pool's reading and the epoch ms its seven_day window resets, from the status file under its config dir. */
  reading: (configDir: string) => { reading?: PoolGateInput['reading']; resetsAt?: number }
  /** The watchdog's recorded run start for the seat, so the tick and the watchdog agree on the run. */
  recordedRunStart: (seat: string) => number | undefined
  /**
   * The watchdog's saved run meter for the seat and day meter for its pool. They stand in for the
   * run-start and day-start readings a seat with no ledger samples yet cannot supply.
   */
  meters?: (seat: string, pool: string) => { run?: SpendMeter | undefined; day?: SpendMeter | undefined }
}

export interface LoadedSeat {
  dispatch: SeatDispatch
  policy: Policy
  budget: PoolGateInput
  state: SeatState
  /** The charter's root, where the week's milestone file lives; absent, no file is read. */
  autonomyRoot?: string
}

export interface LoadedSeats {
  loaded: LoadedSeat[]
  skipped: SkippedSeat[]
}

/** A seat left out of this tick, and why; the tick logs it and carries on with the others. */
export interface SkippedSeat {
  seat: string
  reason: string
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** One pool sample per seat per tick, appended to the seat's ledger samples and pruned to 26 hours. */
function sampled(previous: SeatState | undefined, deps: SeatTickDeps, dispatch: SeatDispatch) {
  const nowMs = deps.now.getTime()
  const { reading, resetsAt } = deps.reading(dispatch.configDir)
  const kept = (previous?.samples ?? []).filter(s => s.at > nowMs - SAMPLE_KEEP_MS && s.at < nowMs)
  const sample: SevenDaySample[] =
    reading?.sevenDay === undefined
      ? []
      : [{ at: nowMs, sevenDay: reading.sevenDay, ...(resetsAt === undefined ? {} : { resetsAt }) }]
  const history = reading?.sevenDay === undefined ? kept : oneSource(kept, dispatch, reading.sevenDay, deps)
  return { reading, resetsAt, history, state: { samples: [...kept, ...sample] } }
}

/**
 * The ledger's samples when they hold a reading at or before the run start, as before CC-782, else the
 * watchdog meters alone. Never both: a meter's samples are estimates that never drop, so sorted among
 * real readings across a seven_day reset, `pointsSpent` would count the pre-reset readings again.
 */
function oneSource(
  kept: SevenDaySample[],
  dispatch: SeatDispatch,
  sevenDay: number,
  deps: SeatTickDeps,
): SevenDaySample[] {
  const recordedAt = deps.recordedRunStart(dispatch.seat)
  const runStart = runStartAt(deps.now, recordedAt === undefined ? {} : { recordedAt })
  if (kept.some(s => s.at <= runStart)) return kept
  const saved = deps.meters?.(dispatch.seat, dispatch.pool.name)
  const metered = saved === undefined ? [] : meterSpend(saved, sevenDay, deps.now).history
  return metered.length === 0 ? kept : metered
}

function loadSeat(policy: Policy, name: string, ledger: Ledger, deps: SeatTickDeps): LoadedSeat {
  const dispatch = resolveSeatDispatch(policy, name)
  const seat = policy.seats[name] as SeatPolicy
  const { reading, resetsAt, history, state } = sampled(ledger.seats?.[name], deps, dispatch)
  const recordedAt = deps.recordedRunStart(name)
  const { pool, spend } = pacedCaps({
    pacing: seat.pacing,
    ...seatBudget(policy.charter, seat),
    sevenDay: reading?.sevenDay,
    resetsAt,
    history,
    now: deps.now,
  })
  return {
    dispatch,
    policy: { ...policy, seat, defaults: mergeDefaults(policy.charter, seat) },
    budget: {
      pool,
      spend,
      reading,
      history,
      runStartAt: runStartAt(deps.now, recordedAt === undefined ? {} : { recordedAt }),
      ctx: { now: deps.now },
    },
    state,
    autonomyRoot: deps.autonomyRoot,
  }
}

/** Reads the charter and seat files once; a seat that throws is skipped, and a later seat retries the load. */
export function loadSeats(names: readonly string[], ledger: Ledger, deps: SeatTickDeps): LoadedSeats {
  const result: LoadedSeats = { loaded: [], skipped: [] }
  let policy: Policy | undefined
  for (const name of names) {
    try {
      policy ??= loadPolicy(deps.autonomyRoot, name)
      result.loaded.push(loadSeat(policy, name, ledger, deps))
    } catch (err) {
      result.skipped.push({ seat: name, reason: message(err) })
    }
  }
  return result
}

export interface SeatPlanDeps {
  ledger: Ledger
  initiatives: readonly Initiative[]
  capacity?: Capacity
  orphan?: PlanInputs['orphan']
  collision?: PlanInputs['collision']
  trust?: (repo: string, cwd: string, configDir: string) => string | undefined
  /** Pools already charged this tick by claims' reviewer and successor spawns, one entry per spawn. */
  charged?: readonly string[]
  /** The broker's roster, which decides which held trees are active; absent, every held tree counts. */
  roster?: Roster
}

/**
 * CC-279: a held tree is active while its claim is spawning, or while a live or
 * spawning agent is assigned to it or stands in it (CC-277's sweep liveness).
 */
export function activeTreeOf(roster: Roster): (claim: Claim) => boolean {
  return claim => {
    if (claim.worktree === undefined) return false
    if (claim.phase === 'spawning') return true
    const assigned = rowNamed(roster, claim.agentName)
    if (assigned !== undefined && isLive(assigned.state)) return true
    return occupantOf(claim.worktree, roster.agents) !== undefined
  }
}

export interface SeatsPlan {
  dispatch: Dispatch[]
  refusals: Refusal[]
  skipped: SkippedSeat[]
  /** Task files read for every planned seat's scope, for the dispatch briefs. */
  tasks: Map<string, Task[]>
  /** Malformed open tasks the scorer left out of each seat's scope, `<slug>/<file>`. */
  skippedTasks: { seat: string; files: string[] }[]
}

/** The broker-wide ceilings less what earlier seats dispatched this tick. */
function lessDispatched(capacity: Capacity | undefined, taken: readonly Dispatch[]): Capacity | undefined {
  if (capacity === undefined) return undefined
  return {
    ...capacity,
    agents: Math.max(0, capacity.agents - taken.length),
    worktrees: repo => {
      const use = capacity.worktrees(repo)
      const added = taken.filter(d => d.repo === repo && d.worktree !== undefined).length
      return { ...use, total: use.total + added, ours: use.ours + added }
    },
  }
}

/** What earlier seats planned this tick: their dispatches and the work each one's collision check saw. */
export interface Taken {
  dispatch: Dispatch[]
  claims: SameTickClaim[]
  charged: readonly string[]
}

export function planLoaded(seat: LoadedSeat, deps: SeatPlanDeps, root: string, taken: Taken) {
  const { charter, seats, defaults } = seat.policy
  const name = seat.dispatch.seat
  const weights = seatScope(charter, seats, name, deps.initiatives)
  const slugs = Object.keys(weights)
  const exclusions = {
    tags: seat.policy.seat.excluded_tags,
    titlePatterns: seat.policy.seat.excluded_title_patterns,
  }
  const today = localDate(seat.budget.ctx.now)
  const read = readScoredTasks(root, slugs)
  const { rows } = scoreAll(read.tasks, weights, defaults, exclusions, charter.hard_stops, today)
  const tasks = new Map(slugs.map(slug => [slug, readTasks(root, slug)]))
  const pool = seat.dispatch.pool.name
  const order = orderInputs(seat, read.tasks, root, today)
  const planned = planSeat({
    seat: seat.dispatch,
    rows,
    defaults,
    order: order.inputs,
    tasks,
    ledger: deps.ledger,
    budget: {
      ...seat.budget,
      dispatched: chargesOn(pool, [...taken.charged, ...taken.dispatch.map(d => d.account)]),
    },
    collision: (repo, work) => sameTickCollision(taken.claims, repo, work) ?? deps.collision?.(repo, work),
    ...optional(deps, lessDispatched(deps.capacity, taken.dispatch)),
  })
  planned.refusals.push(
    ...order.faults.map(reason => ({ initiative: '-', kind: 'plan-blocked' as const, reason })),
  )
  return { planned, tasks, skipped: read.skipped }
}

/** Epics are checked against every task on disk, as `plan --scored` does: the file is shared across seats and an epic may be done. */
function weekMilestones(autonomyRoot: string | undefined, today: string, knownIds: readonly string[]) {
  if (autonomyRoot === undefined) return { faults: [] as string[] }
  try {
    const read = readWeekMilestones(autonomyRoot, today, knownIds)
    if (read === undefined) return { faults: [] as string[] }
    const faults = read.errors.map(error => `milestones ${read.week}: ${describeError(error)}`)
    return read.file === undefined ? { faults } : { milestones: read.file, faults }
  } catch (err) {
    return { faults: [`milestones: ${message(err)}`] }
  }
}

/**
 * CC-768: what `planOrder` reads, assembled as `scoredPlanFromDisk` does. The file is used whenever it parses,
 * and each error is returned for the tick to report; one that does not parse leaves the order to the tags.
 */
function orderInputs(
  seat: LoadedSeat,
  tasks: OrderInputs['tasks'],
  root: string,
  today: string,
): { inputs: OrderInputs; faults: string[] } {
  const knownIds = taskIdsOnDisk(root)
  const { milestones, faults } = weekMilestones(seat.autonomyRoot, today, knownIds)
  return {
    inputs: { tasks, today, knownIds, ...(milestones && { milestones }) },
    faults,
  }
}

function optional(deps: SeatPlanDeps, capacity: Capacity | undefined) {
  return {
    ...(capacity === undefined ? {} : { capacity }),
    ...(deps.orphan === undefined ? {} : { orphan: deps.orphan }),
    ...(deps.trust === undefined ? {} : { trust: deps.trust }),
    ...(deps.roster === undefined ? {} : { activeTree: activeTreeOf(deps.roster) }),
  }
}

/** score.py's `date.today()`: the local calendar date. */
export const localDate = (now: Date): string =>
  [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(n => String(n).padStart(2, '0')).join('-')

/** Each loaded seat in config order, sharing the tick's ceilings, pool charges and claims; a seat whose planning throws is skipped. */
export function planSeats(seats: readonly LoadedSeat[], deps: SeatPlanDeps, root: string): SeatsPlan {
  const result: SeatsPlan = { dispatch: [], refusals: [], skipped: [], tasks: new Map(), skippedTasks: [] }
  const claims: SameTickClaim[] = []
  for (const seat of seats) {
    try {
      const taken = { dispatch: result.dispatch, claims, charged: deps.charged ?? [] }
      const { planned, tasks, skipped } = planLoaded(seat, deps, root, taken)
      if (skipped.length > 0) result.skippedTasks.push({ seat: seat.dispatch.seat, files: skipped })
      for (const [slug, list] of tasks) result.tasks.set(slug, list)
      result.refusals.push(...planned.refusals)
      result.dispatch.push(...planned.dispatch)
      claims.push(...planned.claims)
    } catch (err) {
      result.skipped.push({ seat: seat.dispatch.seat, reason: message(err) })
    }
  }
  return result
}

/** The live readers: the pool's status file and the watchdog's saved run meter. */
export function diskSeatDeps(autonomyRoot: string, root: string, now: Date): SeatTickDeps {
  const doc = loadDoc()
  return {
    autonomyRoot,
    root,
    now,
    reading: configDir => {
      const read = readAccountBudget(configDir, now.getTime())
      const resets = read.found ? read.budget.rate_limits.seven_day?.resets_at : undefined
      const reading = accountReading(read, now.getTime())
      return {
        ...(reading === undefined ? {} : { reading }),
        ...(resets === undefined ? {} : { resetsAt: resets * 1000 }),
      }
    },
    recordedRunStart: seat => doc.seats[seat]?.run?.since,
    meters: (seat, pool) => ({ run: doc.seats[seat]?.run, day: doc.pools[pool] }),
  }
}
