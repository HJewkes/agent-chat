import { readAccountBudget } from '../budget.js'
import { loadDoc } from '../seats/io.js'
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
import { planSeat } from './seat-plan.js'
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
}

export interface LoadedSeat {
  dispatch: SeatDispatch
  policy: Policy
  budget: PoolGateInput
  state: SeatState
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
  return { reading, history: kept, state: { samples: [...kept, ...sample] } }
}

function loadSeat(policy: Policy, name: string, ledger: Ledger, deps: SeatTickDeps): LoadedSeat {
  const dispatch = resolveSeatDispatch(policy, name)
  const seat = policy.seats[name] as SeatPolicy
  const { reading, history, state } = sampled(ledger.seats?.[name], deps, dispatch)
  const recordedAt = deps.recordedRunStart(name)
  return {
    dispatch,
    policy: { ...policy, seat, defaults: mergeDefaults(policy.charter, seat) },
    budget: {
      ...seatBudget(policy.charter, seat),
      reading,
      history,
      runStartAt: runStartAt(deps.now, recordedAt === undefined ? {} : { recordedAt }),
      ctx: { now: deps.now },
    },
    state,
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
interface Taken {
  dispatch: Dispatch[]
  claims: SameTickClaim[]
  charged: readonly string[]
}

function planLoaded(seat: LoadedSeat, deps: SeatPlanDeps, root: string, taken: Taken) {
  const { charter, seats, defaults } = seat.policy
  const name = seat.dispatch.seat
  const weights = seatScope(charter, seats, name, deps.initiatives)
  const slugs = Object.keys(weights)
  const exclusions = {
    tags: seat.policy.seat.excluded_tags,
    titlePatterns: seat.policy.seat.excluded_title_patterns,
  }
  const today = localDate(seat.budget.ctx.now)
  const { rows } = scoreAll(
    readScoredTasks(root, slugs),
    weights,
    defaults,
    exclusions,
    charter.hard_stops,
    today,
  )
  const tasks = new Map(slugs.map(slug => [slug, readTasks(root, slug)]))
  const pool = seat.dispatch.pool.name
  const planned = planSeat({
    seat: seat.dispatch,
    rows,
    defaults,
    tasks,
    ledger: deps.ledger,
    budget: {
      ...seat.budget,
      dispatched: chargesOn(pool, [...taken.charged, ...taken.dispatch.map(d => d.account)]),
    },
    collision: (repo, work) => sameTickCollision(taken.claims, repo, work) ?? deps.collision?.(repo, work),
    ...optional(deps, lessDispatched(deps.capacity, taken.dispatch)),
  })
  return { planned, tasks }
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
  const result: SeatsPlan = { dispatch: [], refusals: [], skipped: [], tasks: new Map() }
  const claims: SameTickClaim[] = []
  for (const seat of seats) {
    try {
      const taken = { dispatch: result.dispatch, claims, charged: deps.charged ?? [] }
      const { planned, tasks } = planLoaded(seat, deps, root, taken)
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
  }
}
