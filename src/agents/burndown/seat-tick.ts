import fs from 'node:fs'
import path from 'node:path'
import type { OwnerItem, OwnerItemDeposit } from '@titan-design/owner-queue'
import { resolvePoolPickMode } from '../../config.js'
import { readAccountBudget } from '../budget.js'
import { loadDoc } from '../seats/io.js'
import { readPace } from '../seats/pace-file.js'
import { pickPool, poolFunds, type PoolPickMode } from '../seats/pool-pick.js'
import { pacedCaps, savedMeters, usableMeters, type SavedMeters } from '../seats/stops.js'
import { accountReading } from '../seats/watchdog.js'
import { billingOrder, firstOpen, type BillingOrder } from './billed-pool.js'
import { chargesOn, gatePool, type PoolGateInput, type SevenDaySample } from './budget-gate.js'
import { sameTickCollision, type SameTickClaim } from './collision.js'
import type { Initiative, Refusal, Task } from './eligibility.js'
import { isLive, occupantOf } from '../isolation/sweep.js'
import type { Claim, Ledger, SeatState } from './ledger.js'
import type { LineStop } from './flow-gate.js'
import { noDispatchReason, stopOf, type SeatOutcome } from './no-dispatch.js'
import { LIVE, rowNamed, type Roster } from './observe.js'
import type { Capacity, Dispatch, PlanInputs } from './plan.js'
import {
  dormantInitiatives,
  loadPolicy,
  resolveSeat,
  seatBudget,
  seatScope,
  type CharterPool,
  type Policy,
  type SeatPolicy,
} from './policy.js'
import { readyFloorFor } from './dispatch-stats.js'
import { scoreAll, type ScoreRow } from './score.js'
import { readScoredTasks } from './score-source.js'
import type { Action } from './advance.js'
import { resolveSeatDispatch, type SeatDispatch } from './seat-dispatch.js'
import { planSeat, type OrderInputs, type SeatBriefGate } from './seat-plan.js'
import { diskPathExists } from './slice-repo.js'
import { parseFunds, parsePools, seatInitiatives, seatPools, type FundsMap } from '../seats/charter.js'
import { run } from './exec.js'
import { branchPrReader, offLedgerRunsIn, seatDispatchRecords } from './off-ledger-adopt.js'
import { diskPlanReader, sliceRunsIn, type SliceRuns } from './seed-slices.js'
import { readPriorRouter } from './prior-route.js'
import { backlogIds, planSectionIds, seatScopeOf, type SeatScope } from './seat-scope.js'
import { describeError, readWeekMilestones, taskIdsOnDisk } from './score-render.js'
import { readOffPlanIds } from './off-plan.js'
import { readTasks, type TickConfig } from './source.js'
import { poolSamples, seatSpend } from './spend-meter.js'

/**
 * CC-205 slice 4: seats mode for one tick. Loads the policy once, samples each
 * enabled seat's pool, and plans its dispatches with `planSeat`. A seat that
 * cannot be loaded or planned is skipped with a reason; the others still run.
 * CLI-only.
 */

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
  /** CC-1145: the pool pick's mode and order for the seat's spawns; absent, the tick bills the seat's home pool. */
  poolPick?: (seat: string, home: string) => { mode: PoolPickMode; order: string[]; funds?: FundsMap }
}

export interface LoadedSeat {
  /** The pool the tick bills: the seat's home, or under `poolPick: enforce` the first open pool (CC-1145). */
  dispatch: SeatDispatch
  policy: Policy
  budget: PoolGateInput
  /** Sampled on the home pool whichever pool is billed, so home's spend series stays whole. */
  state: SeatState
  /** The charter's root, where the week's milestone file lives; absent, no file is read. */
  autonomyRoot?: string
  /** CC-1145: every candidate pool was closed; each one's reason, which the seat's budget refusals carry. */
  closedPools?: string
  /** CC-1145: under `enforce`, the charter's funds map; each task is planned only if the billed pool funds its initiative. */
  funds?: FundsMap
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
  const kept = poolSamples(previous, dispatch.configDir, nowMs)
  const sample: SevenDaySample[] =
    reading?.sevenDay === undefined
      ? []
      : [{ at: nowMs, sevenDay: reading.sevenDay, ...(resetsAt === undefined ? {} : { resetsAt }) }]
  const { history, runStart } = seatSpend({
    seatState: previous,
    configDir: dispatch.configDir,
    saved,
    sevenDay: reading?.sevenDay,
    now: deps.now,
  })
  const marks = {
    ...(previous?.noDispatch === undefined ? {} : { noDispatch: previous.noDispatch }),
    ...(previous?.exhaustedTicks === undefined ? {} : { exhaustedTicks: previous.exhaustedTicks }),
  }
  return {
    reading,
    resetsAt,
    history,
    runStart,
    state: { samples: [...kept, ...sample], configDir: dispatch.configDir, ...marks },
  }
}

function loadSeat(policy: Policy, name: string, ledger: Ledger, deps: SeatTickDeps): LoadedSeat {
  const dispatch = resolveSeatDispatch(policy, name)
  const seat = policy.seats[name] as SeatPolicy
  const saved = usableMeters(deps.meters(name, dispatch.pool.name))
  const { reading, resetsAt, history, runStart, state } = sampled(ledger.seats?.[name], deps, dispatch, saved)
  const { pool, spend } = pacedCaps({
    pacing: seat.pacing,
    ...seatBudget(policy.charter, seat),
    sevenDay: reading?.sevenDay,
    resetsAt,
    history,
    now: deps.now,
  })
  const loaded: LoadedSeat = {
    dispatch,
    policy: { ...policy, seat, ...resolveSeat(policy.charter, seat) },
    budget: {
      pool,
      spend,
      reading,
      history,
      runStartAt: runStart,
      ctx: { now: deps.now },
    },
    state,
    autonomyRoot: deps.autonomyRoot,
  }
  const { funds, ...billing } = billingOf(policy, seat, dispatch, deps)
  if (funds === undefined) return loaded
  return billed(loaded, { ...billing, funds }, other =>
    otherPoolBudget(policy, name, ledger.seats?.[name], other, deps),
  )
}

/** CC-1145: the funded pools the seat's tick may bill, best first; funds unset outside `enforce` keeps home as today. */
function billingOf(
  policy: Policy,
  seat: SeatPolicy,
  home: SeatDispatch,
  deps: SeatTickDeps,
): BillingOrder & { funds?: FundsMap } {
  const pick = deps.poolPick?.(home.seat, home.pool.name) ?? { mode: 'off', order: [] }
  const funds = pick.mode === 'enforce' ? pick.funds : undefined
  const order = billingOrder({
    mode: pick.mode,
    home: home.pool.name,
    pick: pick.order,
    overflow: seat.overflow_pool,
    pools: new Set(Object.keys(policy.charter.pools)),
    funds,
    initiatives: Object.keys(seat.initiatives),
  })
  return { ...order, ...(funds === undefined ? {} : { funds }) }
}

/**
 * CC-1145: a pool other than the seat's home, gated on the pool's own caps alone. The seat's `spend` caps and pacing
 * stay off there, as the broker's `seatSpawnGate` holds them (spawn-gate.ts `own`), and its run meter stays out.
 */
function otherPoolBudget(
  policy: Policy,
  seat: string,
  previous: SeatState | undefined,
  name: string,
  deps: SeatTickDeps,
): PoolGateInput {
  const found = policy.charter.pools[name] as CharterPool
  const { reading, resetsAt } = deps.reading(found.config_dir)
  const { history, runStart } = seatSpend({
    seatState: previous,
    configDir: found.config_dir,
    saved: usableMeters(deps.meters(seat, name)),
    sevenDay: reading?.sevenDay,
    now: deps.now,
    ownRun: false,
  })
  const { pool, spend } = pacedCaps({
    pacing: undefined,
    pool: { ...found, name },
    spend: {},
    sevenDay: reading?.sevenDay,
    resetsAt,
    history,
    now: deps.now,
  })
  return { pool, spend, reading, history, runStartAt: runStart, ctx: { now: deps.now } }
}

/**
 * CC-1145: the seat dispatches on the first open funded pool of `order`, its sample state staying on home. With no
 * funded pool open it keeps home and fails closed, carrying every pool's reason for its budget refusals.
 */
function billed(
  seat: LoadedSeat,
  { order, unfunded, funds }: BillingOrder & { funds: FundsMap },
  other: (pool: string) => PoolGateInput,
): LoadedSeat {
  const loaded = { ...seat, funds }
  if (order.length === 0) return { ...loaded, closedPools: unfunded.join('; ') }
  const home = loaded.dispatch.pool.name
  const budgets = new Map<string, PoolGateInput>([[home, loaded.budget]])
  const budgetOf = (pool: string): PoolGateInput => {
    const budget = budgets.get(pool) ?? other(pool)
    budgets.set(pool, budget)
    return budget
  }
  const chosen = firstOpen(order, pool => gatePool(budgetOf(pool)))
  if (!chosen.open) return { ...loaded, closedPools: [chosen.reason, ...unfunded].join('; ') }
  if (chosen.pool === home) return loaded
  const found = loaded.policy.charter.pools[chosen.pool] as CharterPool
  return {
    ...loaded,
    dispatch: { ...loaded.dispatch, pool: { ...found, name: chosen.pool }, configDir: found.config_dir },
    budget: budgetOf(chosen.pool),
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

type BriefDeps = Pick<TickConfig, 'briefGate' | 'briefMaxAgeDays' | 'maxAgents' | 'handReserve'> &
  Partial<Pick<TickConfig, 'priorRouting'>>

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
  /**
   * The config's per-seat brief gates (CC-925), hand reserves (CC-936) and prior routing (CC-638); absent, every
   * gate is off, no slot is reserved and no workflow table is read.
   */
  brief?: BriefDeps
  /** CC-945: the config's tag-family aliases; required so no caller plans a seat's scope without them. */
  scopeTagAliases: TickConfig['scopeTagAliases']
  /** CC-1158: admits a queued slice onto its one unmerged parent; absent, none stacks. */
  stack?: PlanInputs['stack']
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

/** CC-978: a named agent whose row is running may still run, and so may a name missing from a partial roster. */
export function liveAgentOf(roster: Roster): (name: string | undefined) => boolean {
  return name => {
    const row = rowNamed(roster, name)
    return row === undefined ? name !== undefined && roster.partial !== undefined : LIVE.has(row.state)
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
  /** CC-1228: ledger updates that rehome or park queued slices their seat cannot place. */
  heals: Action[]
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

export function planLoaded(
  seat: LoadedSeat,
  deps: SeatPlanDeps,
  root: string,
  taken: Taken,
  peers?: readonly SeatDispatch[],
) {
  const { charter, seats, defaults, hardStops } = seat.policy
  const name = seat.dispatch.seat
  const weights = seatScope(charter, seats, name, deps.initiatives)
  const slugs = Object.keys(weights)
  const exclusions = {
    tags: seat.policy.seat.excluded_tags,
    titlePatterns: seat.policy.seat.excluded_title_patterns,
  }
  const today = localDate(seat.budget.ctx.now)
  const read = readScoredTasks(root, slugs)
  const scored = scoreAll(
    read.tasks,
    weights,
    defaults,
    exclusions,
    hardStops,
    today,
    dormantInitiatives(seat.policy.seat),
  )
  const { rows, unfunded } = fundedRows(seat, scored.rows)
  const tasks = new Map(slugs.map(slug => [slug, readTasks(root, slug)]))
  const pool = seat.dispatch.pool.name
  const order = orderInputs(seat, read.tasks, root, today)
  const scope = scopeInputs(seat, deps.scopeTagAliases)
  const prior = priorRouterOf(deps, seat)
  const runs = sliceRunsOf(seat)
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
    ...(deps.stack === undefined ? {} : { stack: deps.stack }),
    ...optional(deps, lessDispatched(deps.capacity, taken.dispatch)),
    ...briefGateOf(deps, name),
    ...handReserveOf(deps, name),
    readPlan: diskPlanReader(root),
    sliceRuns: runs.sliceRuns,
    offPlanIds: readOffPlanIds(root),
    pathExists: diskPathExists,
    ...(peers === undefined ? {} : { peers }),
    ...(prior.router === undefined ? {} : { priorRouter: prior.router }),
  })
  if (prior.note !== undefined) planned.notes.push(prior.note)
  if (runs.note !== undefined) planned.notes.push(runs.note)
  planned.notes.push(...scope.notes)
  const closed = seat.closedPools
  if (closed !== undefined)
    planned.refusals = planned.refusals.map(r => (r.kind === 'budget' ? { ...r, reason: closed } : r))
  planned.refusals.push(
    ...unfunded,
    ...[...order.faults, ...scope.faults].map(reason => ({
      initiative: '-',
      kind: 'plan-blocked' as const,
      reason,
    })),
  )
  return { planned, tasks, skipped: read.skipped, plan: scope.scope.plan }
}

/** CC-1145: under `enforce`, a task whose initiative the billed pool does not fund is refused, never billed there. */
function fundedRows(seat: LoadedSeat, rows: ScoreRow[]): { rows: ScoreRow[]; unfunded: Refusal[] } {
  const { funds } = seat
  if (funds === undefined) return { rows, unfunded: [] }
  const pool = seat.dispatch.pool.name
  const kept = rows.filter(row => poolFunds(funds, pool, row.initiative))
  const unfunded = rows
    .filter(row => !kept.includes(row))
    .map(row => ({
      initiative: row.initiative,
      task: row.id,
      kind: 'budget' as const,
      reason: `pool ${pool} is not in the funds map for initiative ${row.initiative}`,
    }))
  return { rows: kept, unfunded }
}

/**
 * CC-1121 b: the seat's dispatch log as slice runs. A seat with no log yet ran none; a log that
 * cannot be read names none either, so seeding fails open with a note. CC-1233: each run carries
 * its branch PR, read from GitHub across the seat's checkouts only when the task is seeded.
 */
function sliceRunsOf(seat: LoadedSeat): { sliceRuns: SliceRuns; note?: string } {
  const { seat: name, prefix, repos } = seat.dispatch
  const none = { sliceRuns: () => [] }
  if (seat.autonomyRoot === undefined) return none
  try {
    const records = seatDispatchRecords(seat.autonomyRoot, name)
    if (records === undefined) return none
    const prOf = branchPrReader(Object.values(repos).flat(), run)
    return {
      sliceRuns: taskId => offLedgerRunsIn(records, sliceRunsIn(records, taskId, prefix), prOf),
    }
  } catch (err) {
    return { ...none, note: `slice runs unread for seat ${name}: ${message(err)}` }
  }
}

/**
 * CC-779: the seat's scope with its backlog's task IDs. A backlog that cannot be read names no task, so
 * the seat keeps only its tagged work in shared initiatives, and the fault is returned for the tick to report.
 * CC-1128: a plan file that cannot be used widens nothing; the seat keeps tag-only scope and the tick notes it.
 */
function scopeInputs(seat: LoadedSeat, aliases?: Readonly<Record<string, string>>): SeatScopeRead {
  return readSeatScope(seat.policy.seats, seat.dispatch.seat, seat.autonomyRoot, aliases)
}

interface SeatScopeRead {
  scope: SeatScope
  faults: string[]
  notes: string[]
}

/** CC-935: `scopeInputs` for a caller holding the seats and the autonomy root, such as `seats boot`. */
export function readSeatScope(
  seats: Policy['seats'],
  name: string,
  autonomyRoot: string | undefined,
  aliases?: Readonly<Record<string, string>>,
): SeatScopeRead {
  const backlog = readBacklog(seats[name]?.backlog, autonomyRoot)
  const plan = readPlan(seats[name]?.plan_file, autonomyRoot)
  return {
    scope: seatScopeOf(seats, name, backlog.ids, aliases, plan.ids),
    faults: backlog.faults,
    notes: plan.notes,
  }
}

function readBacklog(file: string | undefined, autonomyRoot: string | undefined) {
  if (file === undefined || autonomyRoot === undefined) return { ids: new Set<string>(), faults: [] }
  try {
    return { ids: backlogIds(fs.readFileSync(path.join(autonomyRoot, file), 'utf8')), faults: [] }
  } catch (err) {
    return { ids: new Set<string>(), faults: [`backlog ${file}: ${message(err)}`] }
  }
}

/** CC-1128: section 2's task IDs of the seat's plan file, resolved against the autonomy root (absolute allowed). */
function readPlan(
  file: string | undefined,
  autonomyRoot: string | undefined,
): { ids?: Set<string>; notes: string[] } {
  if (file === undefined || autonomyRoot === undefined) return { notes: [] }
  const tagOnly = (why: string) => ({ notes: [`plan ${file}: ${why}; scope is tag-only`] })
  try {
    const ids = planSectionIds(fs.readFileSync(path.resolve(autonomyRoot, file), 'utf8'))
    return ids === undefined ? tagOnly('no "## 2." section') : { ids, notes: [] }
  } catch (err) {
    return tagOnly(message(err))
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

/** The config fields the brief gate, hand reserve and prior routing read; the tick and `plan --seat` both pass these. */
export function briefDepsOf(
  config: Pick<TickConfig, 'briefGate' | 'briefMaxAgeDays' | 'maxAgents' | 'handReserve' | 'priorRouting'>,
): BriefDeps {
  const { briefGate, briefMaxAgeDays, maxAgents, handReserve, priorRouting } = config
  return { briefGate, briefMaxAgeDays, maxAgents, handReserve, priorRouting }
}

/** CC-638: the seat's prior router from its autonomy root's workflow table; `off` or absent reads nothing. */
function priorRouterOf({ brief }: SeatPlanDeps, seat: LoadedSeat): ReturnType<typeof readPriorRouter> {
  const mode = brief?.priorRouting ?? 'off'
  if (mode === 'off') return {}
  if (seat.autonomyRoot === undefined)
    return {
      note: `prior routing ${mode}: seat ${seat.dispatch.seat} has no autonomy root; routing as today`,
    }
  return readPriorRouter(mode, seat.autonomyRoot)
}

/** A seat the config does not name keeps its gate off, and an off gate is passed as none. */
export function briefGateOf({ brief }: SeatPlanDeps, seat: string): { brief?: SeatBriefGate } {
  const gate = brief?.briefGate[seat] ?? 'off'
  return brief === undefined || gate === 'off'
    ? {}
    : {
        brief: {
          gate,
          maxAgeDays: brief.briefMaxAgeDays,
          agingEvery: brief.maxAgents,
          readyFloor: readyFloorFor(brief.maxAgents),
        },
      }
}

/** CC-936: the implementer slots the seat's hand spawns keep; none is passed as none. */
export function handReserveOf({ brief }: SeatPlanDeps, seat: string): { handReserve?: number } {
  const reserve = brief?.handReserve[seat] ?? 0
  return reserve > 0 ? { handReserve: reserve } : {}
}

function optional(deps: SeatPlanDeps, capacity: Capacity | undefined) {
  return {
    ...(capacity === undefined ? {} : { capacity }),
    ...(deps.orphan === undefined ? {} : { orphan: deps.orphan }),
    ...(deps.trust === undefined ? {} : { trust: deps.trust }),
    ...(deps.roster === undefined
      ? {}
      : {
          activeTree: activeTreeOf(deps.roster),
          agents: deps.roster.agents,
          liveAgent: liveAgentOf(deps.roster),
        }),
  }
}

/** score.py's `date.today()`: the local calendar date. */
export const localDate = (now: Date): string =>
  [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(n => String(n).padStart(2, '0')).join('-')

/** CC-1228: the other seats this tick runs, where a slice its seat cannot place may go. */
const peersOf = (seats: readonly LoadedSeat[], seat: LoadedSeat): SeatDispatch[] =>
  seats.filter(s => s !== seat).map(s => s.dispatch)

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
    heals: [],
  }
  const claims: SameTickClaim[] = []
  for (const seat of seats) {
    try {
      const taken = { dispatch: result.dispatch, claims, charged: deps.charged ?? [] }
      // An earlier seat's seeds hold their task, so a later seat neither plans nor seeds it again (CC-927).
      const ledger = { ...deps.ledger, claims: [...deps.ledger.claims, ...result.seeds] }
      const { planned, tasks, skipped, plan } = planLoaded(
        seat,
        { ...deps, ledger },
        root,
        taken,
        peersOf(seats, seat),
      )
      if (skipped.length > 0) result.skippedTasks.push({ seat: seat.dispatch.seat, files: skipped })
      for (const [slug, list] of tasks) result.tasks.set(slug, list)
      result.refusals.push(...planned.refusals)
      result.notes.push(...planned.notes)
      result.seeds.push(...planned.seeds)
      result.heals.push(...planned.heals)
      result.dispatch.push(...planned.dispatch)
      claims.push(...planned.claims)
      const { dispatch, refusals, roles } = planned
      const outcome = { seat: seat.dispatch.seat, dispatched: dispatch.length, refusals, roles }
      result.outcomes.push(plan === undefined ? outcome : { ...outcome, plan })
    } catch (err) {
      result.skipped.push({ seat: seat.dispatch.seat, reason: message(err) })
      result.outcomes.push({ seat: seat.dispatch.seat, dispatched: 0, refusals: [], skipped: message(err) })
    }
  }
  return result
}

/** The reason the watchdog's state file cannot be read, or undefined when it can; the seat paths stay closed while it is set. */
export function watchdogUnusable(): string | undefined {
  try {
    loadDoc()
    return undefined
  } catch (err) {
    return message(err)
  }
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
    poolPick: (seat, home) => diskPoolPick(autonomyRoot, seat, home, now),
  }
}

/**
 * CC-1145: the broker's pick for an unpinned spawn of the seat, over the pools its file allows and the funds map for
 * all its initiatives. Trust is left to the tick's per-task gate on the billed config dir. A fault picks nothing.
 */
function diskPoolPick(
  autonomyRoot: string,
  seat: string,
  home: string,
  now: Date,
): { mode: PoolPickMode; order: string[]; funds?: FundsMap } {
  const mode = resolvePoolPickMode()
  if (mode !== 'enforce') return { mode, order: [] }
  try {
    const charter = fs.readFileSync(path.join(autonomyRoot, 'charter.md'), 'utf8')
    const text = fs.readFileSync(path.join(autonomyRoot, 'seats', `${seat}.md`), 'utf8')
    const funds = parseFunds(charter)
    const allowed = seatPools(text)
    const pools = [...parsePools(charter).values()].filter(
      p => allowed === undefined || allowed.includes(p.name),
    )
    const pick = pickPool({
      pinned: false,
      home,
      pools,
      funds,
      initiatives: seatInitiatives(text),
      pace: readPace(),
      trusted: () => true,
      now: now.getTime(),
    })
    return { mode, order: pick.order, ...(funds === undefined ? {} : { funds }) }
  } catch {
    return { mode, order: [] }
  }
}

/** Ticks in a row a seat must find nothing eligible in scope before it asks the owner. */
export const SCOPE_EXHAUSTED_TICKS = 2

const SCOPE_EXHAUSTED_REC =
  "Rec: let the seat run Discovery overflow from another seat's Overflow list, or wind down; nothing is eligible in scope"

/** The owner queue as the tick sees it: its open items, and a deposit into it. */
export interface OwnerQueuePort {
  open(): Promise<OwnerItem[]>
  /** True when this call wrote the item; false when the deposit id was already in the queue, answered or not. */
  deposit(deposit: OwnerItemDeposit): Promise<boolean>
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
