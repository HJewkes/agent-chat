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
import type { CollisionWork, SameTickClaim } from './collision.js'
import { backoffHeld, type Hold } from './backoff.js'
import { heldClaims, readySlices, type Claim, type Ledger } from './ledger.js'
import {
  agentNameFor,
  capacityRefusal,
  orphanRefusal,
  type Capacity,
  type Dispatch,
  type PlanInputs,
  type Tally,
} from './plan.js'
import {
  dispatchOrder,
  type DispatchRow,
  type Route,
  type ScoreRow,
  type ScoringDefaults,
  type ShareCapRefusals,
} from './score.js'
import { repoForTask, type SeatDispatch } from './seat-dispatch.js'
import { worktreePathFor } from './trust-gate.js'

/**
 * CC-205 D2: one seat's dispatches for a tick. Walks the seat's scored order
 * and gives each row a dispatch or its first refusal. Pure: the caller scores
 * the scope, reads the ledger and the pool, and injects the collision and
 * orphan checks.
 */

export interface SeatPlanInputs {
  seat: SeatDispatch
  /** `scoreAll` rows over the seat's scope. */
  rows: readonly ScoreRow[]
  defaults: ScoringDefaults
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
}

export interface SeatPlan {
  dispatch: Dispatch[]
  claims: SameTickClaim[]
  refusals: Refusal[]
  priorPicks: Record<string, number>
  shareCapped: ShareCapRefusals
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
  /** The broker-wide ceilings, with the charter's worktrees_left_free_per_repo added to the reserve. */
  capacity: Capacity | undefined
  tally: Tally
}

/** Ready slices of the seat's planners first, since their tasks are underway; then the scored order. */
export function planSeat(inputs: SeatPlanInputs): SeatPlan {
  const { budget } = inputs
  const runStart = Math.max(budget.runStartAt, budget.ctx.now.getTime() - RUN_CAP_MS)
  const priorPicks = priorPicksOf(inputs.ledger, inputs.seat.seat, runStart)
  const { order, refused } = dispatchOrder(inputs.rows, inputs.defaults, inputs.rows.length, priorPicks)
  const walk = startWalk(inputs)
  const plan: SeatPlan = { dispatch: [], claims: [], refusals: [], priorPicks, shareCapped: refused }
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
  return plan
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

function consider(row: DispatchRow, walk: Walk): Taken | Refused {
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
  const dispatch = dispatchFor(
    { initiative: row.initiative, task: row.id, profile: route.profile },
    repo,
    reason,
    walk,
  )
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

/** In D6's order: collision, orphan, trust, role cap, worktree caps, then the pool gate. */
function blocker(d: Dispatch, work: CollisionWork, role: Role, walk: Walk): Refused | undefined {
  const { inputs } = walk
  const at = { initiative: d.initiative, repo: d.repo, prefix: d.namePrefix }
  const untrusted = (): Refused | undefined => {
    const reason = inputs.trust?.(d.repo, d.cwd, inputs.seat.configDir)
    return reason === undefined ? undefined : { kind: 'trust', reason }
  }
  return (
    inputs.collision?.(d.repo, work) ??
    // A slice's branch is named for the slice, so the whole-task orphan check does not apply to it.
    (d.slice === undefined ? orphanRefusal(at, d.task, d.profile, inputs.orphan) : undefined) ??
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
