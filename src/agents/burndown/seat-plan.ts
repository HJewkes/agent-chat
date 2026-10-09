import path from 'node:path'
import { gatePool, RUN_CAP_MS, type PoolGateInput, type PoolGateResult } from './budget-gate.js'
import {
  IMPLEMENTER_PROFILE,
  PLANNER_PROFILE,
  SONNET_PROFILES,
  taskRefusal,
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
}

export interface SeatPlan {
  dispatch: Dispatch[]
  claims: SameTickClaim[]
  refusals: Refusal[]
  priorPicks: Record<string, number>
  shareCapped: ShareCapRefusals
  /** `planOrder`'s own decisions for this tick (CC-778); absent when the tick ordered by `dispatchOrder` alone. */
  placement?: Placement
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
  /** The seat's active worktrees per repo: held claims with an active tree plus this plan's dispatches. */
  seatWorktrees: Map<string, number>
  /** The broker-wide ceilings, with the config's worktreeOwnerReserve added to the reserve. */
  capacity: Capacity | undefined
  tally: Tally
}

/** Ready slices of the seat's planners first, since their tasks are underway; then the scored order. */
export function planSeat(inputs: SeatPlanInputs): SeatPlan {
  const { budget } = inputs
  const runStart = Math.max(budget.runStartAt, budget.ctx.now.getTime() - RUN_CAP_MS)
  const priorPicks = priorPicksOf(inputs.ledger, inputs.seat.seat, runStart)
  const { rows, outOfScope } = inScope(inputs)
  const { order, refused, planRefusals, placement } = orderRows({ ...inputs, rows }, priorPicks)
  const plan: SeatPlan = {
    dispatch: [],
    claims: [],
    refusals: [],
    priorPicks,
    shareCapped: refused,
    ...(placement !== undefined && { placement }),
  }
  const walk = startWalk({
    ...inputs,
    collision: (repo, work, landedRepos) =>
      inputs.collision?.(repo, work, landedRepos) ?? contractOverlap(work, acceptedContracts(plan)),
  })
  const take = (initiative: string, task: string, outcome: Taken | Refused): void => {
    if ('kind' in outcome) plan.refusals.push({ initiative, task, ...outcome })
    else {
      const { dispatch, work } = outcome
      plan.dispatch.push(dispatch)
      plan.claims.push({ seat: inputs.seat.seat, repo: dispatch.repo, agentName: dispatch.agentName, work })
      record(dispatch, outcome.role, walk)
    }
  }
  for (const claim of readySlices(inputs.ledger, walk.held).filter(c => c.seat === inputs.seat.seat))
    take(claim.initiative, claim.taskId, considerSlice(claim, walk))
  for (const row of order) take(row.initiative, row.id, consider(row, walk))
  for (const { initiative, task, reason } of planRefusals)
    plan.refusals.push({ initiative, task, kind: 'plan-blocked', reason })
  plan.refusals.push(...outOfScope)
  return plan
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
const acceptedContracts = (plan: SeatPlan) =>
  plan.claims.map(c => ({ holder: c.agentName, contracts: c.work.contracts ?? [] }))

interface Ordered {
  order: (DispatchRow & Partial<Pick<PlannedRow, 'tier'>>)[]
  refused: ShareCapRefusals
  /** Rows `planOrder` dropped for a tag reason, one per task. */
  planRefusals: { initiative: string; task: string; reason: string }[]
  placement?: Placement
}

/** `planOrder`'s order when the tick passed its inputs, else `dispatchOrder`'s. */
function orderRows(inputs: SeatPlanInputs, priorPicks: Record<string, number>): Ordered {
  const { rows, defaults, order: extra } = inputs
  if (extra === undefined)
    return { ...dispatchOrder(rows, defaults, rows.length, priorPicks), planRefusals: [] }
  const base = {
    tasks: extra.tasks,
    defaults,
    today: extra.today,
    seat: inputs.seat.seat,
    ...(extra.milestones !== undefined && { milestones: extra.milestones }),
    ...(extra.knownIds !== undefined && { knownIds: extra.knownIds }),
    failedUpstreams: failedUpstreamsOf(inputs.ledger, extra.tasks),
  }
  const planned = planOrder({ ...base, rows, n: rows.length, priorPicks })
  const shareCapped = Object.entries(planned.refused).filter(([key]) => key.startsWith('share-cap:'))
  return {
    order: planned.order,
    refused: Object.fromEntries(shareCapped) as ShareCapRefusals,
    planRefusals: tagRefusals(rows, planned, base),
    placement: placementOf(planned, defaults.initiative_decay),
  }
}

/**
 * CC-833: open tasks whose last attempt ended terminally, by stall code: a held claim stalled as `failed`, or a
 * task released by the ladder that no claim holds again. A merged task is closed, so it names no dependent.
 */
export function failedUpstreamsOf(ledger: Ledger, open: readonly ScoredTask[]): Record<string, string> {
  const openIds = new Set(open.map(task => task.id))
  const held = ledger.claims.filter(c => c.phase !== 'done')
  const failed: Record<string, string> = {}
  for (const [key, record] of Object.entries(ledger.ladder ?? {})) {
    const taskId = key.split('#')[0] ?? ''
    if ((record.releases ?? 0) > 0 && !held.some(c => c.taskId === taskId))
      failed[taskId] = record.code ?? 'released'
  }
  for (const c of held)
    if (c.stalledClass === 'failed') failed[c.taskId] = c.stallCode ?? c.stalledReason ?? 'failed'
  return Object.fromEntries(Object.entries(failed).filter(([id]) => openIds.has(id)))
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
  for (const role of handSpawnRoles(inputs.agents ?? [], inputs.seat.prefix, held)) roles[role] += 1
  return {
    inputs,
    gate: gatePool(inputs.budget),
    claimed: new Set(held.map(c => c.taskId)),
    held: backoffHeld(inputs.ledger, inputs.budget.ctx.now),
    roles,
    seatWorktrees,
    capacity: withLeftFree(inputs.capacity, inputs.seat.worktrees.leftFreePerRepo),
    tally: { agents: 0, worktrees: new Map() },
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
function handSpawnRoles(agents: readonly AgentIdentity[], prefix: string, held: readonly Claim[]): Role[] {
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

function consider(row: DispatchRow & Partial<Pick<PlannedRow, 'tier'>>, walk: Walk): Taken | Refused {
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
  const reason = `score ${row.score}, effective ${row.effective}`
  const dispatch = {
    ...dispatchFor({ initiative: row.initiative, task: row.id, profile: route.profile }, repo, reason, walk),
    ...(row.tier === undefined ? {} : { tier: row.tier }),
  }
  const work = { taskId: row.id, tags: task.tags, owns: [] }
  return blocker(dispatch, work, route.role, walk) ?? { dispatch, role: route.role, work }
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
  const refused = taskRefusal(task, walk.inputs.seat.grants, walk.claimed, walk.held)
  if (refused?.kind === 'no-done-when' || refused?.kind === 'no-estimate')
    return { kind: 'untriaged', reason: `${refused.reason}; triage stays with the seat's Discovery` }
  if (refused !== undefined) return refused
  if (row.stopShort.length > 0)
    return { kind: 'stop-short', reason: `done_when stops short at ${row.stopShort.join(', ')}` }
  return undefined
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
  return used < cap
    ? undefined
    : { kind: 'role-cap', reason: `seat ${seat.seat} holds ${used} of ${cap} ${role}` }
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
