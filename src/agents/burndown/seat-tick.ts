import fs from 'node:fs'
import path from 'node:path'
import type { OwnerItem, OwnerItemDeposit } from '@titan-design/owner-queue'
import { readAccountBudget } from '../budget.js'
import { loadDoc } from '../seats/io.js'
import { meterSpend, pacedCaps, savedMeters, usableMeters, type SavedMeters } from '../seats/stops.js'
import { accountReading } from '../seats/watchdog.js'
import { chargesOn, runStartAt, type PoolGateInput, type SevenDaySample } from './budget-gate.js'
import { sameTickCollision, type SameTickClaim } from './collision.js'
import type { Initiative, Refusal, Task } from './eligibility.js'
import { isLive, occupantOf } from '../isolation/sweep.js'
import type { Claim, Ledger, SeatState } from './ledger.js'
import type { LineStop } from './flow-gate.js'
import { noDispatchReason, stopOf, type SeatOutcome } from './no-dispatch.js'
import { rowNamed, type Roster } from './observe.js'
import type { Capacity, Dispatch, PlanInputs } from './plan.js'
import {
  dormantInitiatives,
  loadPolicy,
  mergeDefaults,
  seatBudget,
  seatScope,
  type Policy,
  type SeatPolicy,
} from './policy.js'
import { scoreAll } from './score.js'
import { readScoredTasks } from './score-source.js'
import { resolveSeatDispatch, type SeatDispatch } from './seat-dispatch.js'
import { planSeat, type OrderInputs, type SeatBriefGate } from './seat-plan.js'
import { diskPlanReader } from './seed-slices.js'
import { backlogIds, seatScopeOf, type SeatScope } from './seat-scope.js'
import { describeError, readWeekMilestones, taskIdsOnDisk } from './score-render.js'
import { readTasks, type TickConfig } from './source.js'

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
  /**
   * The watchdog's saved run meter for the seat and day meter for its pool, held to `usableMeters`.
   * The run meter's start is the run start, so the tick and the watchdog agree on the run; the meters
   * stand in for the run-start and day-start readings a seat with no ledger samples yet cannot supply.
   */
  meters: (seat: string, pool: string) => SavedMeters
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
function sampled(
  previous: SeatState | undefined,
  deps: SeatTickDeps,
  dispatch: SeatDispatch,
  saved: SavedMeters,
) {
  const nowMs = deps.now.getTime()
  const { reading, resetsAt } = deps.reading(dispatch.configDir)
  const kept = (previous?.samples ?? []).filter(s => s.at > nowMs - SAMPLE_KEEP_MS && s.at < nowMs)
  const sample: SevenDaySample[] =
    reading?.sevenDay === undefined
      ? []
      : [{ at: nowMs, sevenDay: reading.sevenDay, ...(resetsAt === undefined ? {} : { resetsAt }) }]
  const history = reading?.sevenDay === undefined ? kept : oneSource(kept, saved, reading.sevenDay, deps.now)
  const marks = {
    ...(previous?.noDispatch === undefined ? {} : { noDispatch: previous.noDispatch }),
    ...(previous?.exhaustedTicks === undefined ? {} : { exhaustedTicks: previous.exhaustedTicks }),
  }
  return { reading, resetsAt, history, state: { samples: [...kept, ...sample], ...marks } }
}

/**
 * The ledger's samples when they hold a reading at or before the run start, as before CC-782, else the
 * watchdog meters alone. Never both: a meter's samples are estimates that never drop, so sorted among
 * real readings across a seven_day reset, `pointsSpent` would count the pre-reset readings again.
 */
function oneSource(
  kept: SevenDaySample[],
  saved: SavedMeters,
  sevenDay: number,
  now: Date,
): SevenDaySample[] {
  const { history, runStart } = meterSpend(saved, sevenDay, now)
  if (kept.some(s => s.at <= runStart)) return kept
  return history.length === 0 ? kept : history
}

function loadSeat(policy: Policy, name: string, ledger: Ledger, deps: SeatTickDeps): LoadedSeat {
  const dispatch = resolveSeatDispatch(policy, name)
  const seat = policy.seats[name] as SeatPolicy
  const saved = usableMeters(deps.meters(name, dispatch.pool.name))
  const { reading, resetsAt, history, state } = sampled(ledger.seats?.[name], deps, dispatch, saved)
  const recordedAt = saved.run?.since
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
  /** Two stopping service-check reads in a row (CC-785); absent, the line runs. */
  lineStop?: LineStop
  /** The broker's roster, which decides which held trees are active; absent, every held tree counts. */
  roster?: Roster
  /** The config's per-seat brief gates (CC-925); absent, every seat's is off. */
  brief?: Pick<TickConfig, 'briefGate' | 'briefMaxAgeDays'>
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
  /** What each seat's planning came to, for its "dispatched nothing" line (CC-859). */
  outcomes: SeatOutcome[]
  /** Every seat's plan notes, such as a shadow brief gate's `would-refuse` lines (CC-925). */
  notes: string[]
  /** Slice claims seeded from seat-written plans (CC-927), for the tick to add to the ledger. */
  seeds: Claim[]
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
  const { rows } = scoreAll(
    read.tasks,
    weights,
    defaults,
    exclusions,
    charter.hard_stops,
    today,
    dormantInitiatives(seat.policy.seat),
  )
  const tasks = new Map(slugs.map(slug => [slug, readTasks(root, slug)]))
  const pool = seat.dispatch.pool.name
  const order = orderInputs(seat, read.tasks, root, today)
  const scope = scopeInputs(seat)
  const planned = planSeat({
    seat: seat.dispatch,
    rows,
    defaults,
    order: order.inputs,
    scope: scope.scope,
    tasks,
    ledger: deps.ledger,
    budget: {
      ...seat.budget,
      dispatched: chargesOn(pool, [...taken.charged, ...taken.dispatch.map(d => d.account)]),
    },
    collision: (repo, work, landedRepos) =>
      sameTickCollision(taken.claims, repo, work) ?? deps.collision?.(repo, work, landedRepos),
    ...(deps.lineStop === undefined ? {} : { lineStop: deps.lineStop }),
    ...optional(deps, lessDispatched(deps.capacity, taken.dispatch)),
    ...briefGateOf(deps, name),
    readPlan: diskPlanReader(root),
  })
  planned.refusals.push(
    ...[...order.faults, ...scope.faults].map(reason => ({
      initiative: '-',
      kind: 'plan-blocked' as const,
      reason,
    })),
  )
  return { planned, tasks, skipped: read.skipped }
}

/**
 * CC-779: the seat's scope with its backlog's task IDs. A backlog that cannot be read names no task, so
 * the seat keeps only its tagged work in shared initiatives, and the fault is returned for the tick to report.
 */
function scopeInputs(seat: LoadedSeat): { scope: SeatScope; faults: string[] } {
  const { seats } = seat.policy
  const name = seat.dispatch.seat
  const file = seats[name]?.backlog
  if (file === undefined || seat.autonomyRoot === undefined)
    return { scope: seatScopeOf(seats, name, new Set()), faults: [] }
  try {
    const ids = backlogIds(fs.readFileSync(path.join(seat.autonomyRoot, file), 'utf8'))
    return { scope: seatScopeOf(seats, name, ids), faults: [] }
  } catch (err) {
    return { scope: seatScopeOf(seats, name, new Set()), faults: [`backlog ${file}: ${message(err)}`] }
  }
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

/** A seat the config does not name keeps its gate off, and an off gate is passed as none. */
function briefGateOf({ brief }: SeatPlanDeps, seat: string): { brief?: SeatBriefGate } {
  const gate = brief?.briefGate[seat] ?? 'off'
  return brief === undefined || gate === 'off' ? {} : { brief: { gate, maxAgeDays: brief.briefMaxAgeDays } }
}

function optional(deps: SeatPlanDeps, capacity: Capacity | undefined) {
  return {
    ...(capacity === undefined ? {} : { capacity }),
    ...(deps.orphan === undefined ? {} : { orphan: deps.orphan }),
    ...(deps.trust === undefined ? {} : { trust: deps.trust }),
    ...(deps.roster === undefined
      ? {}
      : { activeTree: activeTreeOf(deps.roster), agents: deps.roster.agents }),
  }
}

/** score.py's `date.today()`: the local calendar date. */
export const localDate = (now: Date): string =>
  [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(n => String(n).padStart(2, '0')).join('-')

/** Each loaded seat in config order, sharing the tick's ceilings, pool charges and claims; a seat whose planning throws is skipped. */
export function planSeats(seats: readonly LoadedSeat[], deps: SeatPlanDeps, root: string): SeatsPlan {
  const result: SeatsPlan = {
    dispatch: [],
    refusals: [],
    skipped: [],
    tasks: new Map(),
    skippedTasks: [],
    outcomes: [],
    notes: [],
    seeds: [],
  }
  const claims: SameTickClaim[] = []
  for (const seat of seats) {
    try {
      const taken = { dispatch: result.dispatch, claims, charged: deps.charged ?? [] }
      // An earlier seat's seeds hold their task, so a later seat neither plans nor seeds it again (CC-927).
      const ledger = { ...deps.ledger, claims: [...deps.ledger.claims, ...result.seeds] }
      const { planned, tasks, skipped } = planLoaded(seat, { ...deps, ledger }, root, taken)
      if (skipped.length > 0) result.skippedTasks.push({ seat: seat.dispatch.seat, files: skipped })
      for (const [slug, list] of tasks) result.tasks.set(slug, list)
      result.refusals.push(...planned.refusals)
      result.notes.push(...planned.notes)
      result.seeds.push(...planned.seeds)
      result.dispatch.push(...planned.dispatch)
      claims.push(...planned.claims)
      const { dispatch, refusals } = planned
      result.outcomes.push({ seat: seat.dispatch.seat, dispatched: dispatch.length, refusals })
    } catch (err) {
      result.skipped.push({ seat: seat.dispatch.seat, reason: message(err) })
      result.outcomes.push({ seat: seat.dispatch.seat, dispatched: 0, refusals: [], skipped: message(err) })
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
    meters: (seat, pool) => savedMeters(doc, seat, pool),
  }
}

/** Ticks in a row a seat must find nothing eligible in scope before it asks the owner. */
export const SCOPE_EXHAUSTED_TICKS = 2

const SCOPE_EXHAUSTED_REC =
  "Rec: let the seat run Discovery overflow from another seat's Overflow list, or wind down; nothing is eligible in scope"

/** The owner queue as the tick sees it: its open items, and a deposit into it. */
export interface OwnerQueuePort {
  open(): Promise<OwnerItem[]>
  deposit(deposit: OwnerItemDeposit): Promise<void>
}

const exhaustedKey = (seat: string): string => `scope-exhausted:${seat}`

function exhaustedDeposit(outcome: SeatOutcome, ticks: number, now: Date): OwnerItemDeposit {
  const counts = noDispatchReason(outcome)?.text.split('; ').pop() ?? ''
  return {
    depositId: `scope-exhausted-${outcome.seat}-${now.getTime()}`,
    asker: 'burndown-tick',
    kind: 'decide',
    door: 'two-way',
    summary: `Seat ${outcome.seat} found nothing eligible in scope on ${ticks} ticks in a row`,
    context: `Seat ${outcome.seat} dispatched nothing on ${ticks} consecutive ticks; ${counts}. ${SCOPE_EXHAUSTED_REC}`,
    options: [
      { id: 'overflow', label: 'Run Discovery overflow from another seat’s Overflow list' },
      { id: 'wind-down', label: 'Wind the seat down' },
    ],
    recommended: { optionId: 'overflow', by: 'burndown-tick', rationale: SCOPE_EXHAUSTED_REC },
    keys: [exhaustedKey(outcome.seat)],
    seat: outcome.seat,
  }
}

/**
 * Nothing in scope was eligible: no open task at all, or every candidate refused for its own sake. A stop or a
 * full cap (charter 4.2) is not exhaustion: the seat has work and is waiting.
 */
const nothingEligible = (o: SeatOutcome): boolean => o.dispatched === 0 && stopOf(o.refusals) === undefined

/**
 * CC-864 (charter S17, 7.8): a seat with nothing eligible in scope on two ticks in a row files one "scope
 * exhausted" owner item, unless the queue already holds an open one for the seat. The streak lives in the seat's
 * ledger state as `exhaustedTicks`; a tick that dispatched or met a stop drops it, and a tick that could not plan
 * the seat leaves it.
 */
export async function scopeExhausted(
  outcomes: readonly SeatOutcome[],
  states: Record<string, SeatState>,
  now: Date,
  port: OwnerQueuePort,
): Promise<Record<string, SeatState>> {
  const next = { ...states }
  let open: OwnerItem[] | undefined
  for (const outcome of outcomes) {
    const { exhaustedTicks: streak = 0, ...state } = next[outcome.seat] ?? { samples: [] }
    if (outcome.skipped !== undefined) continue
    if (!nothingEligible(outcome)) {
      next[outcome.seat] = state
      continue
    }
    const ticks = streak + 1
    next[outcome.seat] = { ...state, exhaustedTicks: ticks }
    if (ticks < SCOPE_EXHAUSTED_TICKS) continue
    open ??= await port.open()
    if (open.some(i => i.keys.includes(exhaustedKey(outcome.seat)))) continue
    await port.deposit(exhaustedDeposit(outcome, ticks, now))
  }
  return next
}
