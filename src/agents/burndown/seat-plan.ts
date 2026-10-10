import path from 'node:path'
import { gatePool, RUN_CAP_MS, type PoolGateInput, type PoolGateResult } from './budget-gate.js'
import {
  briefRefusal,
  IMPLEMENTER_PROFILE,
  localDay,
  PLANNER_PROFILE,
  SONNET_PROFILES,
  taskRefusal,
  type BriefCheck,
  type BriefGateMode,
  type Refusal,
  type Task,
} from './eligibility.js'
import { contractOverlap, type CollisionWork, type SameTickClaim } from './collision.js'
import { stopLineRefusal, type LineStop } from './flow-gate.js'
import { backoffHeld, type Hold } from './backoff.js'
import { heldClaims, readySlices, type Claim, type Ledger } from './ledger.js'
import type { AgentIdentity } from '../../protocol.js'
import {
  agentNameFor,
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
import { repoForTask, type SeatDispatch } from './seat-dispatch.js'
import { scopeRefusal, type SeatScope } from './seat-scope.js'
import { seedSlices, type PlanReader } from './seed-slices.js'
import { worktreePathFor } from './trust-gate.js'

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
  /** The seat's brief gate (CC-925); absent, it is off. */
  brief?: SeatBriefGate
  /** CC-936: implementer slots the seat's hand spawns keep; the tick fills the cap minus this. Absent, none. */
  handReserve?: number
  /** A task's seat-written plan (CC-927), read only for planner rows under an `on` gate; absent, none is read. */
  readPlan?: PlanReader
}

export interface SeatBriefGate {
  gate: BriefGateMode
  maxAgeDays: number
  /** `maxAgents` (CC-928): one pick in every this many goes to the longest-ready row; absent, none does. */
  agingEvery?: number
}

export interface SeatPlan {
  dispatch: Dispatch[]
  claims: SameTickClaim[]
  refusals: Refusal[]
  /** What the plan noted without refusing: a shadow brief gate's `would-refuse` lines (CC-925). */
  notes: string[]
  /** `queued` slice claims seeded from seat-written plans in place of a planner (CC-927). */
  seeds: Claim[]
  priorPicks: Record<string, number>
  shareCapped: ShareCapRefusals
  /** `planOrder`'s own decisions for this tick (CC-778); absent when the tick ordered by `dispatchOrder` alone. */
  placement?: Placement
  /** What the seat holds of each role after this plan: held claims, live hand spawns and this tick's dispatches. */
  roles: Record<Role, number>
}

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
type Refused = Pick<Refusal, 'kind' | 'reason'>
type Taken = { dispatch: Dispatch; role: Role; work: CollisionWork }
type Seeded = { seeds: Claim[] }

const ROUTES: Partial<Record<Route, { role: Role; profile: string }>> = {
  planner: { role: 'planners', profile: PLANNER_PROFILE },
  implementer: { role: 'implementers', profile: IMPLEMENTER_PROFILE },
  'implementer-lite': { role: 'implementers', profile: 'bd-implementer-lite' },
}

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
    priorPicks,
    shareCapped: refused,
    ...(placement !== undefined && { placement }),
  }
  const walk = startWalk({
    ...inputs,
    collision: (repo, work, landedRepos) =>
      inputs.collision?.(repo, work, landedRepos) ?? contractOverlap(work, acceptedContracts(plan)),
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
  for (const claim of readySlices(inputs.ledger, walk.held).filter(c => c.seat === inputs.seat.seat))
    take(claim.initiative, claim.taskId, considerSlice(claim, walk))
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
  for (const { initiative, task, reason } of planRefusals)
    plan.refusals.push({ initiative, task, kind: 'plan-blocked', reason })
  plan.refusals.push(...outOfScope)
  plan.notes.push(...walk.notes)
  return { ...plan, roles: { ...walk.roles } }
}

type Outcome = Taken | Refused | Seeded

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
    else outOfScope.push({ initiative: row.initiative, task: row.id, kind: 'out-of-scope', reason })
  }
  return { rows, outOfScope }
}

/** The dispatches this pass already accepted: a queued claim holds nothing in the ledger until it goes out. */
const acceptedContracts = (plan: Pick<SeatPlan, 'claims'>) =>
  plan.claims.map(c => ({ holder: c.agentName, contracts: c.work.contracts ?? [] }))

interface Ordered {
  order: (DispatchRow & Partial<Pick<PlannedRow, 'tier'>>)[]
  refused: ShareCapRefusals
  /** Rows `planOrder` dropped for a tag reason, one per task. */
  planRefusals: { initiative: string; task: string; reason: string }[]
  placement?: Placement
}

/** `planOrder`'s order when the tick passed its inputs, else `dispatchOrder`'s; an `on` brief gate re-ranks it. */
function orderRows(inputs: SeatPlanInputs, priorPicks: Record<string, number>): Ordered {
  const ordered = baseOrder(inputs, priorPicks)
  if (inputs.brief?.gate !== 'on') return ordered
  return { ...ordered, order: briefReadyFirst(inputs, ordered.order) }
}

/** CC-926: share caps and initiative decay do not apply to the ready set, so the base order is built without them. */
function baseOrder(inputs: SeatPlanInputs, priorPicks: Record<string, number>): Ordered {
  const { rows, order: extra } = inputs
  const defaults =
    inputs.brief?.gate === 'on'
      ? { ...inputs.defaults, share_caps: {}, initiative_decay: 1 }
      : inputs.defaults
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
    placement: placementOf(planned, inputs.defaults.initiative_decay),
  }
}

/** Brief-ready rows by `readyOrder`; the rest follow in their base order, where the gate refuses them. */
function briefReadyFirst(inputs: SeatPlanInputs, order: Ordered['order']): Ordered['order'] {
  const ready = readyRows(inputs, order)
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
  for (const claim of ours) {
    const role = roleOf(claim)
    if (role !== undefined) roles[role] += 1
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
    seatWorktrees,
    capacity: withLeftFree(inputs.capacity, inputs.seat.worktrees.leftFreePerRepo),
    tally: { agents: 0, worktrees: new Map() },
    notes: [],
  }
}

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
  const repo = repoForTask(seat, row.initiative, task.tags)
  if (repo === undefined)
    return { kind: 'no-repo', reason: `seat ${seat.seat} lists no repo for ${row.initiative}` }
  const seeded = route.role === 'planners' ? seedFromPlan(row, walk) : undefined
  if (seeded !== undefined) return seeded
  const reason = `score ${row.score}, effective ${row.effective}`
  const dispatch = {
    ...dispatchFor({ initiative: row.initiative, task: row.id, profile: route.profile }, repo, reason, walk),
    ...(row.tier === undefined ? {} : { tier: row.tier }),
  }
  const work = { taskId: row.id, tags: task.tags, owns: [] }
  return blocker(dispatch, work, route.role, walk) ?? { dispatch, role: route.role, work }
}

/**
 * CC-927: under an `on` gate, a brief-ready task's seat-written plan stands in for the planner. Its slices
 * hold the task from here and dispatch as ready slices from the next tick; a plan failing the lint blocks it.
 */
function seedFromPlan(row: DispatchRow, walk: Walk): Seeded | Refused | undefined {
  const { seat, brief, readPlan, ledger, budget } = walk.inputs
  if (brief?.gate !== 'on' || readPlan === undefined) return undefined
  const parent = { taskId: row.id, initiative: row.initiative, seat: seat.seat, namePrefix: seat.prefix }
  const seeding = seedSlices(parent, readPlan(row.initiative, row.id), ledger, budget.ctx.now)
  if (seeding === undefined) return undefined
  if ('blocked' in seeding) return { kind: 'plan-blocked', reason: seeding.blocked }
  walk.claimed.add(row.id)
  const slices = seeding.claims.map(c => c.slice).join(', ')
  walk.notes.push(
    `seeded ${row.initiative} ${row.id} slices ${slices} from ${seeding.plan} (seat ${seat.seat})`,
  )
  return { seeds: seeding.claims }
}

/** A queued slice goes to an implementer in the repo its task's tags pick, owning the paths its plan declares. */
function considerSlice(claim: Claim, walk: Walk): Taken | Refused {
  const { seat, tasks } = walk.inputs
  const tags = tasks.get(claim.initiative)?.find(t => t.id === claim.taskId)?.tags ?? []
  const repo = repoForTask(seat, claim.initiative, tags)
  if (repo === undefined)
    return { kind: 'no-repo', reason: `seat ${seat.seat} lists no repo for ${claim.initiative}` }
  const work = {
    initiative: claim.initiative,
    task: claim.taskId,
    profile: IMPLEMENTER_PROFILE,
    ...(claim.slice === undefined ? {} : { slice: claim.slice }),
  }
  const dispatch = dispatchFor(work, repo, `ready slice ${claim.slice ?? '?'}`, walk)
  const checked = {
    taskId: claim.taskId,
    ...(claim.slice === undefined ? {} : { slice: claim.slice }),
    tags,
    owns: claim.owns ?? [],
    contracts: claim.contracts ?? [],
  }
  return blocker(dispatch, checked, 'implementers', walk) ?? { dispatch, role: 'implementers', work: checked }
}

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
  return (
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
  )
}

function roleCap(role: Role, walk: Walk): Refused | undefined {
  const { seat } = walk.inputs
  const used = walk.roles[role]
  const cap = seat.caps[role]
  if (used >= cap) return { kind: 'role-cap', reason: `seat ${seat.seat} holds ${used} of ${cap} ${role}` }
  const reserve = role === 'implementers' ? (walk.inputs.handReserve ?? 0) : 0
  const tickUsed = used - walk.handImplementers
  return reserve === 0 || tickUsed < cap - reserve
    ? undefined
    : {
        kind: 'role-cap',
        reason: `seat ${seat.seat} holds ${tickUsed} tick ${role} of ${cap - reserve}; handReserve keeps ${reserve} of ${cap}`,
      }
}

function worktreeCap(d: Dispatch, walk: Walk): Refused | undefined {
  const { perRepoPerSeat, capName } = walk.inputs.seat.worktrees
  const ours = walk.seatWorktrees.get(d.repo) ?? 0
  if (d.worktree !== undefined && ours >= perRepoPerSeat)
    return {
      kind: 'worktrees',
      reason: `seat ${d.seat ?? '?'} holds ${ours} active worktrees under ${d.repo}/.worktrees; ${capName} is ${perRepoPerSeat}`,
    }
  return capacityRefusal(d, walk.capacity, walk.tally)
}

function budgetRefusal(profile: string, gate: PoolGateResult): Refused | undefined {
  if (!gate.open) return { kind: 'budget', reason: gate.reason }
  if (gate.sonnetOnly && !SONNET_PROFILES.has(profile))
    return { kind: 'budget', reason: `${gate.reason}; task needs ${profile}` }
  return undefined
}
