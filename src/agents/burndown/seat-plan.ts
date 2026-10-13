import path from 'node:path'
import { gatePool, RUN_CAP_MS, type PoolGateInput, type PoolGateResult } from './budget-gate.js'
import {
  briefRefusal,
  IMPLEMENTER_PROFILE,
  isBriefer,
  localDay,
  PLANNER_PROFILE,
  SONNET_PROFILES,
  sliceRefusal,
  taskRefusal,
  type BriefCheck,
  type BriefGateMode,
  type Refusal,
  type RefusalKind,
  type Task,
} from './eligibility.js'
import { binaryGate, capGate } from './gate-reading.js'
import { contractOverlap, liveOverlap, type CollisionWork, type SameTickClaim } from './collision.js'
import { stopLineRefusal, type LineStop } from './flow-gate.js'
import { backoffHeld, type Hold } from './backoff.js'
import { heldClaims, readySlices, slotMismatch, type Claim, type Ledger } from './ledger.js'
import type { AgentIdentity } from '../../protocol.js'
import {
  agentNameFor,
  BURNDOWN_CONFIG,
  capacityRefusal,
  orphanRefusal,
  type Capacity,
  type Dispatch,
  type PlanInputs,
  type Tally,
} from './plan.js'
import type { MilestoneFile } from './milestones.js'
import { planOrder, type PlannedRow } from './plan-order.js'
import { agedFirst, agingTurn, briefReadyDay, readySet } from './ready-order.js'
import {
  dispatchOrder,
  type DispatchRow,
  type Route,
  type ScoreRow,
  type ScoredTask,
  type ScoringDefaults,
  type ShareCapRefusals,
} from './score.js'
import type { SeatDispatch } from './seat-dispatch.js'
import { scopeRefusal, type SeatScope } from './seat-scope.js'
import { healSlice, sliceRepo, taskRepo, type PathExists } from './slice-repo.js'
import type { Action } from './advance.js'
import { parkUpdate } from './stall-code.js'
import { seedSlices, type PlanReader, type SliceRuns } from './seed-slices.js'
import { OFF_PLAN_REASON } from './off-plan.js'
import { offPlanRefusals, planningCandidates, readyDepth } from './planning-supply.js'
import { worktreePathFor } from './trust-gate.js'
import { planFacts, priorRoute, type PriorRouter, type Routed } from './prior-route.js'
import { shareOrder, sharedDefaults, type ProjectShares } from './project-shares.js'
import type { TaskFacts } from './classify-task.js'

/**
 * CC-205 D2: one seat's dispatches for a tick. Walks the seat's scored order
 * and gives each row a dispatch or its first refusal. Pure: the caller scores
 * the scope, reads the ledger and the pool, and injects the collision and
 * orphan checks.
 */

/** What `planOrder` reads beyond the scored rows (CC-768); a plan without it keeps `dispatchOrder`'s order. */
export interface OrderInputs {
  /** Every open task in scope, excluded ones included, as `scoredPlan` passes them. */
  tasks: readonly ScoredTask[]
  /** ISO day. */
  today: string
  milestones?: MilestoneFile
  knownIds?: readonly string[]
}

export interface SeatPlanInputs {
  seat: SeatDispatch
  /** `scoreAll` rows over the seat's scope. */
  rows: readonly ScoreRow[]
  defaults: ScoringDefaults
  order?: OrderInputs
  /** Task files by initiative, for the eligibility checks the scorer does not make. */
  tasks: ReadonlyMap<string, Task[]>
  ledger: Ledger
  /** The seat's pool gate; its `runStartAt` also bounds the prior picks. */
  budget: PoolGateInput
  capacity?: Capacity
  orphan?: PlanInputs['orphan']
  collision?: PlanInputs['collision']
  /** Why `cwd` cannot be spawned into on the pool's config dir, as `plan()` checks in `place()`. */
  trust?: (repo: string, cwd: string, configDir: string) => string | undefined
  /** Whether a held claim's tree is active (CC-279); absent, every held tree counts. */
  activeTree?: (claim: Claim) => boolean
  /** Set while the service check has failed twice running (CC-629); absent, the line runs. */
  lineStop?: LineStop
  /** The seat's `scope_tags` and backlog (CC-779); absent, every scored row is in scope. */
  scope?: SeatScope
  /** The broker's roster (CC-779): the seat's running agents count against its caps; absent, only claims do. */
  agents?: readonly AgentIdentity[]
  /** CC-978: whether the named agent may still run; absent, every implementing claim holds a slot. */
  liveAgent?: (name: string | undefined) => boolean
  /** The seat's brief gate (CC-925); absent, it is off. */
  brief?: SeatBriefGate
  /** CC-936: implementer slots the seat's hand spawns keep; the tick fills the cap minus this. Absent, none. */
  handReserve?: number
  /** A task's seat-written plan (CC-927), read only for planner rows under an `on` gate; absent, none is read. */
  readPlan?: PlanReader
  /** CC-1121 b: slice agents the seat's dispatch log shows already ran for a task; absent, none did. */
  sliceRuns?: SliceRuns
  /** CC-1112: task ids a factory-review file marked off-plan; briefers refuse them. Absent, none are extra. */
  offPlanIds?: ReadonlySet<string>
  /** Whether a path exists in a checkout, for placing a ready slice by what it owns (CC-946); absent, owns place nothing. */
  pathExists?: PathExists
  /** CC-638: route implementer dispatches by the task-time prior; absent, today's route picks the profile. */
  priorRouter?: PriorRouter
  /** CC-1107: project shares of the seat's whole-task picks; absent, the legacy order (decay, kind weights, share caps). */
  shares?: ProjectShares
  /** CC-1158: admits a queued slice onto its one unmerged parent; absent, none stacks. */
  stack?: PlanInputs['stack']
  /** CC-1228: the other seats this tick runs; set, a queued slice the seat cannot place moves to one that can or parks `no-repo`. Absent, it is refused each tick. */
  peers?: readonly SeatDispatch[]
}

export interface SeatBriefGate {
  gate: BriefGateMode
  maxAgeDays: number
  /** `maxAgents` (CC-928): one pick in every this many goes to the longest-ready row; absent, none does. */
  agingEvery?: number
  /** CC-986: under an `on` gate, a ready depth below this sends briefers to the no-brief rows; absent, none go. */
  readyFloor?: number
}

export interface SeatPlan {
  dispatch: Dispatch[]
  claims: SameTickClaim[]
  refusals: Refusal[]
  /** What the plan noted without refusing: a shadow brief gate's `would-refuse` lines (CC-925). */
  notes: string[]
  /** `queued` slice claims seeded from seat-written plans in place of a planner (CC-927). */
  seeds: Claim[]
  /** CC-1228: ledger updates that rehome or park queued slices the seat cannot place. */
  heals: Action[]
  priorPicks: Record<string, number>
  shareCapped: ShareCapRefusals
  /** `planOrder`'s own decisions for this tick (CC-778); absent when the tick ordered by `dispatchOrder` alone. */
  placement?: Placement
  /** What the seat holds of each role after this plan: held claims, live hand spawns and this tick's dispatches. */
  roles: Record<Role, number>
  /** CC-1107: each initiative's configured share and its whole-task picks this run, this tick's included; absent without shares. */
  shareMix?: ShareMix
}

export type ShareMix = Record<string, { share: number; picks: number }>

/** A placed row's tier, with the milestone, slack and float that put it there. */
export type PlacedTier = Pick<PlannedRow, 'tier' | 'milestone' | 'slack' | 'float'>

export interface Placement {
  /** Every row `planOrder` placed, by task ID. */
  tiers: Record<string, PlacedTier>
  /**
   * `planOrder`'s picks in order, dispatched or not; each decays its initiative for the tier 3 and 4
   * rows picked after it. A share-cap skip is no pick, so it decays nothing.
   */
  picks: { id: string; initiative: string; tier: number }[]
  /** The `initiative_decay` factor each pick applies. */
  decay: number
  /** The ready intangible IDs held back for a ready row of a higher tier. */
  intangibleHeld: string[]
}

type Role = keyof SeatDispatch['caps']
const ROLES: readonly Role[] = ['implementers', 'reviewers', 'planners']
type Refused = Pick<Refusal, 'kind' | 'reason' | 'gate'>
type Taken = { dispatch: Dispatch; role: Role; work: CollisionWork }
type Seeded = { seeds: Claim[] }
/** CC-986: an implementer-routed task with no plan to seed from; a planner writes the one at this path. */
type Replan = { replan: string }

const ROUTES: Partial<Record<Route, { role: Role; profile: string }>> = {
  briefer: { role: 'planners', profile: PLANNER_PROFILE },
  planner: { role: 'planners', profile: PLANNER_PROFILE },
  implementer: { role: 'implementers', profile: IMPLEMENTER_PROFILE },
  'implementer-lite': { role: 'implementers', profile: 'bd-implementer-lite' },
}

/** CC-986: the route a brief:ready task with no plan takes, so a planner writes the slices that declare its owns. */
const PLANNER_ROUTE = { role: 'planners', profile: PLANNER_PROFILE } as const

const ROLE_OF_PHASE: Partial<Record<Claim['phase'], Role>> = {
  planning: 'planners',
  implementing: 'implementers',
  reviewing: 'reviewers',
}

/** A spawning claim counts toward the role it lands in. */
const roleOf = (claim: Claim): Role | undefined =>
  ROLE_OF_PHASE[claim.phase === 'spawning' ? (claim.nextPhase ?? 'spawning') : claim.phase]

/** The seat's whole-task claims dispatched since `runStartAt`, by initiative; a planner's slices are the same pick. */
export function priorPicksOf(ledger: Ledger, seat: string, runStartAt: number): Record<string, number> {
  const picks: Record<string, number> = {}
  for (const c of ledger.claims) {
    if (c.seat === seat && c.slice === undefined && Date.parse(c.spawnedAt) >= runStartAt)
      picks[c.initiative] = (picks[c.initiative] ?? 0) + 1
  }
  return picks
}

interface Walk {
  inputs: SeatPlanInputs
  gate: PoolGateResult
  claimed: Set<string>
  /** Tasks inside their release backoff (CC-661). */
  held: ReadonlyMap<string, Hold>
  roles: Record<Role, number>
  /** The hand-spawned implementers in `roles`; the tick's own are the rest. */
  handImplementers: number
  /** CC-1098: held claims left out of `roles` because no agent runs for them; they keep their task, not a slot. */
  idle: Record<Role, number>
  /** The seat's active worktrees per repo: held claims with an active tree plus this plan's dispatches. */
  seatWorktrees: Map<string, number>
  /** The broker-wide ceilings, with the config's worktreeOwnerReserve added to the reserve. */
  capacity: Capacity | undefined
  tally: Tally
  notes: string[]
}

/** Ready slices of the seat's planners first, since their tasks are underway; then the scored order. */
export function planSeat(inputs: SeatPlanInputs): SeatPlan {
  const { budget } = inputs
  const runStart = Math.max(budget.runStartAt, budget.ctx.now.getTime() - RUN_CAP_MS)
  const priorPicks = priorPicksOf(inputs.ledger, inputs.seat.seat, runStart)
  const { rows, outOfScope } = inScope(inputs)
  const { order, refused, planRefusals, placement } = orderRows({ ...inputs, rows }, priorPicks)
  const plan: Omit<SeatPlan, 'roles'> = {
    dispatch: [],
    claims: [],
    refusals: [],
    notes: [],
    seeds: [],
    heals: [],
    priorPicks,
    shareCapped: refused,
    ...(placement !== undefined && { placement }),
  }
  const walk = startWalk({
    ...inputs,
    collision: (repo, work, landedRepos) =>
      inputs.collision?.(repo, work, landedRepos) ??
      liveOverlap(work, repo, acceptedOwns(plan)) ??
      contractOverlap(work, acceptedContracts(plan)),
  })
  const take = (initiative: string, task: string, outcome: Taken | Refused | Seeded): void => {
    if ('kind' in outcome) plan.refusals.push({ initiative, task, ...outcome })
    else if ('seeds' in outcome) plan.seeds.push(...outcome.seeds)
    else {
      const { dispatch, work } = outcome
      plan.dispatch.push(dispatch)
      plan.claims.push({ seat: inputs.seat.seat, repo: dispatch.repo, agentName: dispatch.agentName, work })
      record(dispatch, outcome.role, walk)
    }
  }
  const own = readySlices(inputs.ledger, walk.held, inputs.stack).filter(c => c.seat === inputs.seat.seat)
  const slices = healSlices(own, walk, plan)
  // Rows are counted first: a taken slice claims its task, which would hide that task's row.
  const rowDepth = supplyDepth(order, walk)
  const depth = rowDepth + takeSlices(slices, walk, take)
  const picked = Object.values(priorPicks).reduce((sum, n) => sum + n, 0)
  const aging = { aged: agedRows(inputs, order), every: inputs.brief?.agingEvery ?? 1 }
  walkOrder(
    order,
    aging,
    () => picked + plan.dispatch.length,
    row => {
      const outcome = consider(row, walk)
      take(row.initiative, row.id, outcome)
      return outcome
    },
  )
  planBelowFloor(plan, depth, walk, take)
  for (const { initiative, task, reason } of planRefusals)
    plan.refusals.push({ initiative, task, kind: 'plan-blocked', reason })
  plan.refusals.push(...outOfScope)
  plan.notes.push(...walk.notes)
  plan.notes.push(...idleNotes(inputs.seat.seat, walk))
  const shareMix =
    inputs.shares === undefined ? undefined : shareMixOf(inputs.shares, priorPicks, plan.dispatch)
  return { ...plan, roles: { ...walk.roles }, ...(shareMix !== undefined && { shareMix }) }
}

/** Shares count whole-task picks, as `priorPicksOf` does: a slice dispatch is part of its task's pick. */
function shareMixOf(
  shares: ProjectShares,
  priorPicks: Readonly<Record<string, number>>,
  dispatch: readonly Dispatch[],
): ShareMix {
  const picks = new Map(Object.entries(priorPicks))
  for (const d of dispatch)
    if (d.slice === undefined) picks.set(d.initiative, (picks.get(d.initiative) ?? 0) + 1)
  const slugs = new Set([...Object.keys(shares.initiatives), ...picks.keys()])
  return Object.fromEntries(
    [...slugs].map(slug => [slug, { share: shares.initiatives[slug] ?? 0, picks: picks.get(slug) ?? 0 }]),
  )
}

type Outcome = Taken | Refused | Seeded

/** The seat's ready rows before this tick dispatches anything: the rows `consider` would not refuse. */
function supplyDepth(order: readonly DispatchRow[], walk: Walk): number {
  const check = briefCheck(walk.inputs)
  if (check === undefined) return 0
  const taskOf = taskOfRow(walk.inputs)
  const dispatchable = (row: DispatchRow): boolean => {
    const task = taskOf(row)
    if (task === undefined || row.stopShort.length > 0) return false
    const { seat } = walk.inputs
    if (taskRefusal(task, seat.grants, walk.claimed, walk.held) !== undefined) return false
    if (briefRefusal(task, check) !== undefined) return false
    const repo = taskRepo(seat, row.initiative, task.tags)
    if (repo === undefined || ROUTES[row.route] === undefined) return false
    const work = { taskId: row.id, tags: task.tags, owns: [] }
    return walk.inputs.collision?.(repo, work, landedRepos(seat)) === undefined
  }
  return readyDepth(order, dispatchable, 0)
}

/** A planner cap or a closed pool stops the pass; any other refusal leaves that row refused no-brief. */
const STOPS_PLANNING: ReadonlySet<Refusal['kind']> = new Set(['role-cap', 'budget'])

/**
 * CC-986: under an `on` gate with a ready depth below the floor, briefers take the no-brief rows in walk
 * order until the planner cap or the pool stops them. Each dispatch replaces its row's no-brief refusal.
 */
function planBelowFloor(
  plan: Pick<SeatPlan, 'refusals'>,
  depth: number,
  walk: Walk,
  take: (initiative: string, task: string, outcome: Taken) => void,
): void {
  const { brief, seat, tasks } = walk.inputs
  if (brief?.gate !== 'on' || brief.readyFloor === undefined || depth >= brief.readyFloor) return
  const reason = `ready ${depth} below floor ${brief.readyFloor}`
  const offPlanIds = walk.inputs.offPlanIds ?? new Set<string>()
  for (const refusal of offPlanRefusals(plan.refusals, tasks, offPlanIds)) {
    refusal.kind = 'off-plan'
    refusal.reason = OFF_PLAN_REASON
  }
  let planned = 0
  for (const refusal of planningCandidates(plan.refusals, tasks, offPlanIds)) {
    const outcome = briefFor(refusal, reason, walk)
    if (outcome === undefined) continue
    if ('kind' in outcome) {
      if (STOPS_PLANNING.has(outcome.kind)) break
      continue
    }
    plan.refusals.splice(plan.refusals.indexOf(refusal), 1)
    take(refusal.initiative, outcome.work.taskId, outcome)
    planned += 1
  }
  walk.notes.push(`seat ${seat.seat} ${reason}: planning ${planned} no-brief tasks`)
}

/** A briefer for a no-brief row, as `consider` sends one for a `brief:wanted` task; undefined with no repo. */
function briefFor(refusal: Refusal, reason: string, walk: Walk): Taken | Refused | undefined {
  const { seat, tasks } = walk.inputs
  const task = tasks.get(refusal.initiative)?.find(t => t.id === refusal.task)
  const repo = task === undefined ? undefined : taskRepo(seat, refusal.initiative, task.tags)
  if (task === undefined || repo === undefined) return undefined
  const work = { initiative: refusal.initiative, task: task.id, profile: PLANNER_PROFILE }
  const dispatch = { ...dispatchFor(work, repo, reason, walk), briefer: true }
  const checked = { taskId: task.id, tags: task.tags, owns: [] }
  return blocker(dispatch, checked, 'planners', walk) ?? { dispatch, role: 'planners', work: checked }
}

/**
 * Considers each row in order. Before a row, when the seat's next pick is its aging slot, the aged rows get
 * the pick first, longest-ready first: a refused one is spent and the next is tried, so a row the walk
 * always refuses cannot hold the slot. With none aged the order is untouched.
 */
function walkOrder(
  order: readonly DispatchRow[],
  aging: { aged: readonly DispatchRow[]; every: number },
  picks: () => number,
  run: (row: DispatchRow) => Outcome,
): void {
  const done = new Set<DispatchRow>()
  const once = (row: DispatchRow): Outcome => {
    done.add(row)
    return run(row)
  }
  for (let i = 0; i < order.length;) {
    const row = order[i]!
    const turn = aging.aged.length > 0 && agingTurn(picks(), aging.every)
    if (turn && aging.aged.filter(r => !done.has(r)).some(r => !('kind' in once(r)))) continue
    if (!done.has(row)) once(row)
    i += 1
  }
}

/** Rows outside the seat's scope leave before ordering, so they spend no share cap or initiative decay. */
function inScope(inputs: SeatPlanInputs): { rows: ScoreRow[]; outOfScope: Refusal[] } {
  const rows: ScoreRow[] = []
  const outOfScope: Refusal[] = []
  for (const row of inputs.rows) {
    const tags = inputs.tasks.get(row.initiative)?.find(t => t.id === row.id)?.tags ?? []
    const reason = scopeRefusal(inputs.scope, row.initiative, { id: row.id, tags })
    if (reason === undefined) rows.push(row)
    else outOfScope.push({ initiative: row.initiative, task: row.id, kind: 'out-of-scope', reason, tags })
  }
  return { rows, outOfScope }
}

/** The dispatches this pass already accepted: a queued claim holds nothing in the ledger until it goes out. */
const acceptedContracts = (plan: Pick<SeatPlan, 'claims'>) =>
  plan.claims.map(c => ({ holder: c.agentName, contracts: c.work.contracts ?? [] }))

const acceptedOwns = (plan: Pick<SeatPlan, 'claims'>) =>
  plan.claims.map(c => ({ holder: c.agentName, repo: c.repo, owns: c.work.owns }))

interface Ordered {
  order: (DispatchRow & Partial<Pick<PlannedRow, 'tier'>>)[]
  refused: ShareCapRefusals
  /** Rows `planOrder` dropped for a tag reason, one per task. */
  planRefusals: { initiative: string; task: string; reason: string }[]
  placement?: Placement
}

/**
 * `planOrder`'s order when the tick passed its inputs, else `dispatchOrder`'s; an `on` brief gate re-ranks it.
 * Project shares (CC-1107) then interleave the rows the walk can take: the ready set under an `on` gate, else all.
 */
function orderRows(inputs: SeatPlanInputs, priorPicks: Record<string, number>): Ordered {
  const ordered = baseOrder(inputs, priorPicks)
  const byShares = <T extends Ordered['order'][number]>(rows: readonly T[]): T[] =>
    inputs.shares === undefined ? [...rows] : shareOrder(rows, inputs.shares, priorPicks)
  if (inputs.brief?.gate !== 'on')
    return inputs.shares === undefined ? ordered : { ...ordered, order: byShares(ordered.order) }
  return { ...ordered, order: briefReadyFirst(inputs, ordered.order, byShares) }
}

/**
 * CC-926: share caps and initiative decay do not apply to the ready set, so the base order is built without them.
 * CC-1107: under shares, decay is 1, kind weights are the default and the kind caps come from `shares.kinds`.
 */
function scoringDefaults(inputs: SeatPlanInputs): ScoringDefaults {
  if (inputs.shares !== undefined) return sharedDefaults(inputs.defaults, inputs.shares)
  if (inputs.brief?.gate === 'on') return { ...inputs.defaults, share_caps: {}, initiative_decay: 1 }
  return inputs.defaults
}

function baseOrder(inputs: SeatPlanInputs, priorPicks: Record<string, number>): Ordered {
  const { rows, order: extra } = inputs
  const defaults = scoringDefaults(inputs)
  if (extra === undefined)
    return { ...dispatchOrder(rows, defaults, rows.length, priorPicks), planRefusals: [] }
  const base = {
    tasks: extra.tasks,
    defaults,
    today: extra.today,
    seat: inputs.seat.seat,
    ...(extra.milestones !== undefined && { milestones: extra.milestones }),
    ...(extra.knownIds !== undefined && { knownIds: extra.knownIds }),
    failedUpstreams: failedUpstreamsOf(inputs.ledger),
  }
  const planned = planOrder({ ...base, rows, n: rows.length, priorPicks })
  const shareCapped = Object.entries(planned.refused).filter(([key]) => key.startsWith('share-cap:'))
  return {
    order: planned.order,
    refused: Object.fromEntries(shareCapped) as ShareCapRefusals,
    planRefusals: tagRefusals(rows, planned, base),
    placement: placementOf(planned, inputs.shares === undefined ? inputs.defaults.initiative_decay : 1),
  }
}

/** Brief-ready rows by `readyOrder`, then `rerank`; the rest follow in their base order, where the gate refuses them. */
function briefReadyFirst(
  inputs: SeatPlanInputs,
  order: Ordered['order'],
  rerank: (rows: Ordered['order']) => Ordered['order'],
): Ordered['order'] {
  const ready = rerank(readyRows(inputs, order))
  const taken = new Set(ready)
  return [...ready, ...order.filter(r => !taken.has(r))]
}

function readyRows(inputs: SeatPlanInputs, order: Ordered['order']): Ordered['order'] {
  const { brief, budget } = inputs
  if (brief === undefined) return []
  const check: BriefCheck = { maxAgeDays: brief.maxAgeDays, now: budget.ctx.now }
  return readySet(order, taskOfRow(inputs), check, inputs.scope)
}

const taskOfRow = (inputs: SeatPlanInputs) => (r: { initiative: string; id: string }) =>
  inputs.tasks.get(r.initiative)?.find(t => t.id === r.id)

/**
 * CC-928: the rows the aging slot may take, longest-ready first; empty unless an `on` gate carries `agingEvery`.
 * The walk offers the slot to them and takes the first its own checks accept.
 */
function agedRows(inputs: SeatPlanInputs, order: Ordered['order']): Ordered['order'] {
  const { brief, budget } = inputs
  if (brief?.gate !== 'on' || brief.agingEvery === undefined) return []
  const taskOf = taskOfRow(inputs)
  const readyDay = (r: Ordered['order'][number]): number | undefined => {
    const task = taskOf(r)
    return task === undefined ? undefined : briefReadyDay(task)
  }
  return agedFirst(readyRows(inputs, order), readyDay, localDay(budget.ctx.now))
}

/**
 * CC-833: tasks held by a claim that stalled as `failed`, by stall code, from any seat. A task outside the seat's
 * scope is in `knownIds` only, which `planOrder` takes as closed, so without this its dependent would dispatch.
 * A ladder release is no failure: the task goes back to the pool after its backoff.
 */
export function failedUpstreamsOf(ledger: Ledger): Record<string, string> {
  return Object.fromEntries(
    ledger.claims
      .filter(c => c.phase !== 'done' && c.stalledClass === 'failed')
      .map(c => [c.taskId, c.stallCode ?? c.stalledReason ?? 'failed']),
  )
}

/** The highest tier `planOrder` sorts itself; tiers 3 and 4 follow `dispatchOrder`, decayed by the rows above them. */
export const LAST_SORTED_TIER = 2

function placementOf(planned: ReturnType<typeof planOrder>, decay: number): Placement {
  const tiers: Record<string, PlacedTier> = {}
  for (const { id, tier, milestone, slack, float } of planned.order)
    tiers[id] = {
      tier,
      ...(milestone !== undefined && { milestone }),
      ...(slack !== undefined && { slack }),
      ...(float !== undefined && { float }),
    }
  const picks = planned.order.map(({ id, initiative, tier }) => ({ id, initiative, tier }))
  return { tiers, picks, decay, intangibleHeld: planned.intangibleHeld }
}

const HOLDS = (key: string) => key.startsWith('share-cap:') || key === 'intangible-held'

/**
 * `planOrder` counts its tag refusals (`dep-blocked`, `gated:<id>`, ...) without naming the task, so each
 * row it dropped is placed alone to learn its reason. Placement reads the tags of every task, not the rows.
 */
function tagRefusals(
  rows: readonly ScoreRow[],
  planned: ReturnType<typeof planOrder>,
  base: Omit<Parameters<typeof planOrder>[0], 'rows' | 'n'>,
): Ordered['planRefusals'] {
  if (!Object.keys(planned.refused).some(key => !HOLDS(key))) return []
  const placed = new Set(planned.order.map(row => row.id))
  return rows
    .filter(row => row.blocked.length === 0 && !placed.has(row.id))
    .flatMap(row => {
      const alone = planOrder({ ...base, rows: [row], n: 1 })
      const reason = Object.keys(alone.refused).find(key => !HOLDS(key))
      return reason === undefined ? [] : [{ initiative: row.initiative, task: row.id, reason }]
    })
}

function startWalk(inputs: SeatPlanInputs): Walk {
  const held = heldClaims(inputs.ledger)
  const ours = held.filter(c => c.seat === inputs.seat.seat)
  const roles: Record<Role, number> = { implementers: 0, reviewers: 0, planners: 0 }
  const seatWorktrees = new Map<string, number>()
  const active = inputs.activeTree ?? (() => true)
  const idle: Record<Role, number> = { implementers: 0, reviewers: 0, planners: 0 }
  for (const claim of ours) {
    const role = roleOf(claim)
    if (role !== undefined) (holdsSlot(claim, inputs.liveAgent) ? roles : idle)[role] += 1
    if (claim.worktree !== undefined && active(claim))
      bump(seatWorktrees, path.dirname(path.dirname(claim.worktree)))
  }
  const hand = handSpawnRoles(inputs.agents ?? [], inputs.seat.prefix, held)
  for (const role of hand) roles[role] += 1
  return {
    inputs,
    gate: gatePool(inputs.budget),
    claimed: new Set(held.map(c => c.taskId)),
    held: backoffHeld(inputs.ledger, inputs.budget.ctx.now),
    roles,
    handImplementers: hand.filter(role => role === 'implementers').length,
    idle,
    seatWorktrees,
    capacity: withLeftFree(inputs.capacity, inputs.seat.worktrees.leftFreePerRepo),
    tally: { agents: 0, worktrees: new Map() },
    notes: [],
  }
}

/**
 * CC-1098: a claim holds its role's slot while it is spawning, its agent may run, or a ladder respawn is about to
 * spawn its successor. One whose agent is gone is ledger state, not live work, even with a PR open at Shepherd.
 */
const holdsSlot = (claim: Claim, live: SeatPlanInputs['liveAgent']): boolean =>
  claim.phase === 'spawning' || live === undefined || claim.respawn !== undefined || live(claim.agentName)

/** CC-978: what a role counts against its cap, beside the ledger's own count when the two differ. */
export const roleUsed = (role: Role, used: number, idle: number): string => {
  if (idle === 0) return `${role} used ${used}`
  const mismatch = slotMismatch(used + idle, used)
  return `${role} used ${used} (ledger ${used + idle})${mismatch === undefined ? '' : ` ${mismatch}`}`
}

const idleNotes = (seat: string, walk: Walk): string[] =>
  ROLES.filter(role => walk.idle[role] > 0).map(
    role => `seat ${seat} ${roleUsed(role, walk.roles[role], walk.idle[role])}`,
  )

const HAND_ROLES: readonly [string, Role][] = [
  ['implementer', 'implementers'],
  ['reviewer', 'reviewers'],
  ['planner', 'planners'],
]

/** Every name a held claim's agents carry: the claim's own, its spawns, and its `-r<n>` and `-s<n>` names. */
function claimAgent(held: readonly Claim[]): (name: string) => boolean {
  const names = new Set(held.flatMap(c => [c.agentName ?? '', ...(c.spawned ?? [])]))
  const bases = new Set(held.map(c => agentNameFor(c.taskId, c.slice, c.namePrefix)))
  return name => names.has(name) || bases.has(name.replace(/-[rs]\d+$/, ''))
}

/**
 * CC-779: the seat's running agents its prefix names that no held claim accounts for, by the first role
 * word in the profile as `seats status` counts them; a profile naming no role counts toward no cap.
 */
export function handSpawnRoles(
  agents: readonly AgentIdentity[],
  prefix: string,
  held: readonly Claim[],
): Role[] {
  const ofClaim = claimAgent(held)
  return agents
    .filter(a => a.name.startsWith(`${prefix}-`) && a.state !== 'exited' && a.state !== 'retired')
    .filter(a => !ofClaim(a.name))
    .flatMap(a => HAND_ROLES.find(([word]) => a.profile.includes(word))?.[1] ?? [])
}

const bump = (counts: Map<string, number>, key: string): void => {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

function withLeftFree(capacity: Capacity | undefined, free: number): Capacity | undefined {
  if (capacity === undefined) return undefined
  return {
    ...capacity,
    worktrees: repo => {
      const use = capacity.worktrees(repo)
      return { ...use, totalCeiling: Math.max(0, use.totalCeiling - free) }
    },
  }
}

function record(d: Dispatch, role: Role, walk: Walk): void {
  walk.roles[role] += 1
  walk.claimed.add(d.task)
  walk.tally.agents += 1
  const { budget } = walk.inputs
  walk.gate = gatePool({ ...budget, dispatched: (budget.dispatched ?? 0) + walk.tally.agents })
  if (d.worktree === undefined) return
  bump(walk.tally.worktrees, d.repo)
  bump(walk.seatWorktrees, d.repo)
}

function consider(
  row: DispatchRow & Partial<Pick<PlannedRow, 'tier'>>,
  walk: Walk,
): Taken | Refused | Seeded {
  const { seat, tasks } = walk.inputs
  const task = tasks.get(row.initiative)?.find(t => t.id === row.id)
  if (task === undefined) return { kind: 'not-open', reason: 'scored, but no open task file was read for it' }
  const ineligible = eligibility(row, task, walk)
  if (ineligible !== undefined) return ineligible
  const route = ROUTES[row.route]
  if (route === undefined)
    return { kind: 'untriaged', reason: "route triage; triage stays with the seat's Discovery" }
  const repo = taskRepo(seat, row.initiative, task.tags)
  if (repo === undefined)
    return { kind: 'no-repo', reason: `seat ${seat.seat} lists no repo for ${row.initiative}` }
  const seeded = seedFromPlan(row, task, route.role, walk)
  if (seeded !== undefined && !('replan' in seeded)) return seeded
  const { role, profile, note }: { role: Role } & Routed =
    seeded === undefined ? taskRoute(row, task, route, walk) : PLANNER_ROUTE
  const reason = `score ${row.score}, effective ${row.effective}`
  const dispatch = {
    ...dispatchFor({ initiative: row.initiative, task: row.id, profile }, repo, reason, walk),
    ...(row.tier === undefined ? {} : { tier: row.tier }),
    ...(isBriefer(task) ? { briefer: true } : {}),
  }
  const work = { taskId: row.id, tags: task.tags, owns: [] }
  const refused = blocker(dispatch, work, role, walk)
  if (refused !== undefined) return refused
  if (seeded !== undefined)
    walk.notes.push(`planning ${row.initiative} ${row.id}: no plan at ${seeded.replan} (seat ${seat.seat})`)
  if (note !== undefined) walk.notes.push(note)
  return { dispatch, role, work }
}

/** CC-638: an implementer row's profile by its prior, its facts read only when a router is set. */
function taskRoute(
  row: DispatchRow,
  task: Task,
  route: { role: Role; profile: string },
  walk: Walk,
): { role: Role } & Routed {
  if (route.role !== 'implementers') return route
  const label = `${row.initiative} ${row.id} (seat ${walk.inputs.seat.seat})`
  const facts = () => factsOf(task, planFacts(planText(walk, row.initiative, row.id)).owns)
  return { role: route.role, ...priorProfile(route.profile, label, facts, walk) }
}

/** A queued slice is classified by its own owns and points, with its task's tags and done_when. */
function sliceRoute(claim: Claim, task: Task | undefined, walk: Walk): Routed {
  const slice = claim.slice === undefined ? '' : ` slice ${claim.slice}`
  const label = `${claim.initiative} ${claim.taskId}${slice} (seat ${walk.inputs.seat.seat})`
  const facts = (): TaskFacts => {
    const { points } = planFacts(planText(walk, claim.initiative, claim.taskId), claim.slice)
    const base = factsOf(task, claim.owns ?? [])
    return points === undefined ? base : { ...base, estimate: points }
  }
  return priorProfile(IMPLEMENTER_PROFILE, label, facts, walk)
}

function priorProfile(today: string, label: string, facts: () => TaskFacts, walk: Walk): Routed {
  const router = walk.inputs.priorRouter
  return router === undefined ? { profile: today } : priorRoute(router, facts(), today, label)
}

const planText = (walk: Walk, initiative: string, taskId: string): string | undefined =>
  walk.inputs.readPlan?.(initiative, taskId).text

const factsOf = (task: Task | undefined, owns: readonly string[]): TaskFacts => ({
  estimate: task?.estimate ?? null,
  done_when: task?.doneWhen ?? null,
  tags: task?.tags ?? [],
  owns,
})

/**
 * CC-927: under an `on` gate, a brief-ready task's seat-written plan stands in for the planner. Its slices
 * hold the task from here and dispatch as ready slices from the next tick; a plan failing the lint blocks it.
 * CC-952: an implementer-routed task seeds the same way, since only the plan's slices declare the files it
 * will touch. CC-986: with no plan it goes to a planner instead of being refused. A planner with no plan runs as before.
 */
function seedFromPlan(
  row: DispatchRow,
  task: Task,
  role: Role,
  walk: Walk,
): Seeded | Replan | Refused | undefined {
  const { seat, brief, readPlan, ledger, budget, sliceRuns } = walk.inputs
  if (readPlan === undefined || (row.route !== 'planner' && role !== 'implementers')) return undefined
  if (brief?.gate === 'shadow' && role === 'implementers')
    return briefRefusal(task, { ...brief, now: budget.ctx.now }) === undefined
      ? noteShadowOwns(row, readPlan, walk)
      : undefined
  if (brief?.gate !== 'on') return undefined
  const plan = readPlan(row.initiative, row.id)
  if (plan.text === undefined && role === 'implementers') return { replan: plan.path }
  const parent = { taskId: row.id, initiative: row.initiative, seat: seat.seat, namePrefix: seat.prefix }
  const seeding = seedSlices(parent, plan, ledger, budget.ctx.now, sliceRuns)
  if (seeding === undefined) return undefined
  if ('blocked' in seeding) return { kind: 'plan-blocked', reason: seeding.blocked }
  walk.claimed.add(row.id)
  const slices = seeding.claims.map(c => c.slice).join(', ')
  walk.notes.push(
    `seeded ${row.initiative} ${row.id} slices ${slices} from ${seeding.plan} (seat ${seat.seat})`,
  )
  for (const warning of seeding.warnings)
    walk.notes.push(`slice-lint ${row.initiative} ${row.id}: ${warning}`)
  return { seeds: seeding.claims }
}

/** A shadow gate dispatches the implementer as today and notes that `on` would send a planner for want of a plan. */
function noteShadowOwns(row: DispatchRow, readPlan: PlanReader, walk: Walk): undefined {
  const plan = readPlan(row.initiative, row.id)
  if (plan.text !== undefined) return undefined
  const seat = walk.inputs.seat.seat
  walk.notes.push(`would-plan ${row.initiative} ${row.id} (seat ${seat}): no plan at ${plan.path}`)
  return undefined
}

/**
 * CC-1228: a slice the seat cannot place is rehomed or parked in the ledger and leaves this pass; a parked one waits
 * silently, so its refusal no longer repeats. A slice the seat can place now clears an earlier park.
 */
function healSlices(slices: readonly Claim[], walk: Walk, plan: Pick<SeatPlan, 'heals'>): Claim[] {
  const { seat, tasks, peers, pathExists } = walk.inputs
  if (peers === undefined) return [...slices]
  return slices.filter(claim => {
    const tags = tasks.get(claim.initiative)?.find(t => t.id === claim.taskId)?.tags ?? []
    const heal = healSlice(seat, peers, claim.initiative, tags, claim, pathExists)
    const key = { taskId: claim.taskId, slice: claim.slice }
    if (heal === undefined) return true
    if (heal.kind === 'unpark') {
      plan.heals.push({ kind: 'update', key, patch: UNPARKED })
      return true
    }
    if (heal.kind === 'rehome') {
      const patch = { seat: heal.to, ...UNPARKED }
      plan.heals.push({ kind: 'update', key, patch })
      walk.notes.push(`rehomed ${claim.taskId} slice ${claim.slice ?? '?'} from ${seat.seat} to ${heal.to}`)
    }
    if (heal.kind === 'park') {
      plan.heals.push(parkUpdate(key, 'no-repo', heal.reason))
      walk.notes.push(`parked ${claim.taskId} slice ${claim.slice ?? '?'} no-repo: ${heal.reason}`)
    }
    return false
  })
}

const UNPARKED = { stalledReason: undefined, stalledClass: undefined, stallCode: undefined }

/** A queued slice goes to an implementer in the repo its task's tags pick, owning the paths its plan declares. */
function considerSlice(claim: Claim, walk: Walk): Taken | Refused {
  const { seat, tasks } = walk.inputs
  const task = tasks.get(claim.initiative)?.find(t => t.id === claim.taskId)
  const gated = sliceRefusal(task, seat.excludedTags)
  if (gated !== undefined) return gated
  const tags = task?.tags ?? []
  const placed = sliceRepo(seat, claim.initiative, tags, claim, walk.inputs.pathExists)
  if ('ambiguous' in placed) return { kind: 'repo-ambiguous', reason: placed.ambiguous }
  const { repo } = placed
  if (repo === undefined)
    return {
      kind: 'no-repo',
      reason: `seat ${seat.seat} lists no repo${claim.repo === undefined ? '' : ` ${claim.repo}`} for ${claim.initiative}`,
    }
  const { profile, note } = sliceRoute(claim, task, walk)
  const work = {
    initiative: claim.initiative,
    task: claim.taskId,
    profile,
    ...(claim.slice === undefined ? {} : { slice: claim.slice }),
  }
  const dispatch = {
    ...dispatchFor(work, repo, `ready slice ${claim.slice ?? '?'}`, walk),
    ...(claim.owns?.length ? { owns: claim.owns } : {}),
    ...(claim.stackedOn === undefined ? {} : { stackedOn: claim.stackedOn }),
  }
  const checked = sliceWork(claim, tags)
  const refused = blocker(dispatch, checked, 'implementers', walk)
  if (refused !== undefined) return refused
  if (note !== undefined) walk.notes.push(note)
  return { dispatch, role: 'implementers', work: checked }
}

/**
 * Takes each ready slice and returns the slice supply for the brief floor: the slices dispatched or refused
 * only by a role cap (CC-1160, owner decision 273). A role-cap refusal means every earlier check in `blocker`
 * passed. Two role-capped slices that overlap each other both count, since collision sees only accepted work.
 */
function takeSlices(
  slices: readonly Claim[],
  walk: Walk,
  take: (i: string, t: string, o: Outcome) => void,
): number {
  let supply = 0
  for (const claim of slices) {
    const outcome = considerSlice(claim, walk)
    if (!('kind' in outcome) || outcome.kind === 'role-cap') supply += 1
    take(claim.initiative, claim.taskId, outcome)
  }
  return supply
}

const sliceWork = (claim: Claim, tags: string[]): CollisionWork => ({
  taskId: claim.taskId,
  ...(claim.slice === undefined ? {} : { slice: claim.slice }),
  tags,
  owns: claim.owns ?? [],
  contracts: claim.contracts ?? [],
  ...(claim.stackedOn === undefined ? {} : { stackedOn: claim.stackedOn }),
})

function eligibility(row: DispatchRow, task: Task, walk: Walk): Refused | undefined {
  const brief = briefCheck(walk.inputs)
  const refused = taskRefusal(task, walk.inputs.seat.grants, walk.claimed, walk.held, brief)
  if (refused?.kind === 'no-done-when' || refused?.kind === 'no-estimate')
    return { kind: 'untriaged', reason: `${refused.reason}; triage stays with the seat's Discovery` }
  if (refused !== undefined) return refused
  if (row.stopShort.length > 0)
    return { kind: 'stop-short', reason: `done_when stops short at ${row.stopShort.join(', ')}` }
  if (brief?.gate === 'shadow') noteShadowBrief(row, task, brief, walk)
  return undefined
}

type SeatBriefCheck = BriefCheck & SeatBriefGate

/** The gate takes "now" from the pool gate's clock, as the backoff check does. */
const briefCheck = ({ brief, budget }: SeatPlanInputs): SeatBriefCheck | undefined =>
  brief === undefined ? undefined : { ...brief, now: budget.ctx.now }

/** A shadow gate dispatches as today and notes what `on` would have refused. */
function noteShadowBrief(row: DispatchRow, task: Task, brief: SeatBriefCheck, walk: Walk): void {
  const would = briefRefusal(task, brief)
  if (would === undefined) return
  const seat = walk.inputs.seat.seat
  walk.notes.push(`would-refuse ${would.kind} ${row.initiative} ${row.id} (seat ${seat}): ${would.reason}`)
}

type Work = Pick<Dispatch, 'initiative' | 'task' | 'slice' | 'profile'>

/** The seat's git checkouts: a `git: false` path is no repo to read, and reading it would refuse every task (CC-834). */
function landedRepos(seat: SeatDispatch): string[] {
  const nonGit = new Set(seat.nonGitRepos ?? [])
  return Object.values(seat.repos)
    .flat()
    .filter(repo => !nonGit.has(repo))
}

function dispatchFor(work: Work, repo: string, reason: string, walk: Walk): Dispatch {
  const { seat } = walk.inputs
  const agentName = agentNameFor(work.task, work.slice, seat.prefix)
  const worktree = work.profile === PLANNER_PROFILE ? undefined : worktreePathFor(repo, agentName)
  return {
    ...work,
    account: seat.pool.name,
    cwd: worktree ?? repo,
    repo,
    agentName,
    ...(worktree === undefined ? {} : { worktree }),
    reason: `${reason}; ${walk.gate.reason}`,
    seat: seat.seat,
    namePrefix: seat.prefix,
    configDir: seat.configDir,
    grants: seat.grants,
  }
}

/** In D6's order: stop-line, collision, orphan, trust, role cap, worktree caps, then the pool gate. */
function blocker(d: Dispatch, work: CollisionWork, role: Role, walk: Walk): Refused | undefined {
  const { inputs } = walk
  const flow = { tags: work.tags, planner: role === 'planners' }
  const at = { initiative: d.initiative, repo: d.repo, prefix: d.namePrefix }
  const untrusted = (): Refused | undefined => {
    const reason = inputs.trust?.(d.repo, d.cwd, inputs.seat.configDir)
    return reason === undefined ? undefined : { kind: 'trust', reason }
  }
  const refused =
    stopLineRefusal(flow, inputs.lineStop) ??
    inputs.collision?.(d.repo, work, landedRepos(inputs.seat)) ??
    // A slice's branch is named for the slice, so the whole-task orphan check does not apply to it.
    (d.slice === undefined
      ? orphanRefusal(at, d.task, d.profile, inputs.orphan, inputs.ledger)
      : undefined) ??
    untrusted() ??
    roleCap(role, walk) ??
    worktreeCap(d, walk) ??
    budgetRefusal(d.profile, walk.gate)
  return refused === undefined || ('gate' in refused && refused.gate !== undefined)
    ? refused
    : {
        ...refused,
        gate: binaryGate(`gate.${refused.kind}`, BINARY_SOURCES[refused.kind] ?? COLLISION_SOURCE),
      }
}

/** CC-1097: where a binary stop is read; every collision kind reads the ledger and the open PRs. */
const BINARY_SOURCES: Partial<Record<RefusalKind, string>> = {
  'stop-line': 'service line stop',
  orphan: 'repo branches and worktrees no claim accounts for',
  trust: "the seat config dir's Claude trust state",
}
const COLLISION_SOURCE = 'ledger claims and open PR files'

function roleCap(role: Role, walk: Walk): Refused | undefined {
  const { seat } = walk.inputs
  const used = walk.roles[role]
  const cap = seat.caps[role]
  const ledger = walk.idle[role] > 0 ? ` (ledger ${used + walk.idle[role]})` : ''
  if (used >= cap)
    return {
      kind: 'role-cap',
      reason: `seat ${seat.seat} holds ${used} of ${cap} ${role}${ledger}`,
      gate: capGate(`concurrency.${role}`, cap, used, SEAT_SOURCE),
    }
  const reserve = role === 'implementers' ? (walk.inputs.handReserve ?? 0) : 0
  const tickUsed = used - walk.handImplementers
  return reserve === 0 || tickUsed < cap - reserve
    ? undefined
    : {
        kind: 'role-cap',
        reason: `seat ${seat.seat} holds ${tickUsed} tick ${role} of ${cap - reserve}; handReserve keeps ${reserve} of ${cap}`,
        gate: capGate('burndown.handReserve', cap - reserve, tickUsed, BURNDOWN_CONFIG),
      }
}

function worktreeCap(d: Dispatch, walk: Walk): Refused | undefined {
  const { perRepoPerSeat, capName } = walk.inputs.seat.worktrees
  const ours = walk.seatWorktrees.get(d.repo) ?? 0
  if (d.worktree !== undefined && ours >= perRepoPerSeat)
    return {
      kind: 'worktrees',
      reason: `seat ${d.seat ?? '?'} holds ${ours} active worktrees under ${d.repo}/.worktrees; ${capName} is ${perRepoPerSeat}`,
      gate: capGate(capName, perRepoPerSeat, ours, SEAT_SOURCE),
    }
  return capacityRefusal(d, walk.capacity, walk.tally)
}

function budgetRefusal(profile: string, gate: PoolGateResult): Refused | undefined {
  if (!gate.open) return { kind: 'budget', reason: gate.reason, gate: gate.gate }
  if (gate.sonnetOnly && !SONNET_PROFILES.has(profile))
    return {
      kind: 'budget',
      reason: `${gate.reason}; task needs ${profile}`,
      // The band's figure is the window reading the reason already shows, so the lever stays binary.
      gate: binaryGate(`pools.${gate.pool}.sonnet_band_points`, 'autonomy charter pools'),
    }
  return undefined
}

const SEAT_SOURCE = 'seats/<seat>.md'
