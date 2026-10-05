import type { Autonomy } from '../active-work.js'
import type { Collision, CollisionWork } from './collision.js'
import { pickAccount, type AccountReading, type AccountRule, type GateContext } from './budget-gate.js'
import {
  byRank,
  IMPLEMENTER_PROFILE,
  pickTask,
  PLANNER_PROFILE,
  profileFor,
  SONNET_PROFILES,
  type Initiative,
  type Refusal,
  type Task,
} from './eligibility.js'
import { backoffHeld } from './backoff.js'
import { heldClaims, laneClaims, readySlices, type Ledger } from './ledger.js'
import { worktreePathFor } from './trust-gate.js'

/**
 * One dry-run tick: at most one dispatch per opted-in initiative, and a
 * reason for everything it did not dispatch. Nothing here spawns or writes.
 */

export interface Dispatch {
  initiative: string
  task: string
  /** A planner's slice, dispatched from a `queued` claim rather than a task file. */
  slice?: string
  profile: string
  account: string
  /** Where trust was checked: the repo for a planner, the worktree the spawn will cut otherwise. */
  cwd: string
  repo: string
  agentName: string
  /** The worktree the spawn cuts; absent for a planner, which shares the checkout. */
  worktree?: string
  reason: string
  /** The class-of-service tier `planOrder` placed the task in (CC-768); absent for a slice and for an initiative's own plan. */
  tier?: number
  /** The seat that dispatched it (CC-205); absent for an initiative's autonomy block. */
  seat?: string
  /** Prefix of the agent names the claim spawns; absent means `bd`. */
  namePrefix?: string
  /** The seat pool's Claude config dir; absent means the account's. */
  configDir?: string
  /** The seat's `grants_extra`; absent means the initiative's autonomy grants. */
  grants?: string[]
}

/** Worktrees under one repo's `.worktrees`: every one, and those the tick's own agents hold. */
export interface WorktreeUse {
  total: number
  ours: number
  /** The broker's per-repo budget less the reserve the tick never takes. */
  totalCeiling: number
  oursCeiling: number
}

/** The tick's own ceilings, under the broker's; `burndown plan` never spawns and passes none. */
export interface Capacity {
  /** New agents this run may still start, after `maxAgents` and the broker's free slots. */
  agents: number
  agentsReason: string
  worktrees: (repo: string) => WorktreeUse
}

export interface PlanInputs {
  initiatives: Initiative[]
  tasks: ReadonlyMap<string, Task[]>
  ledger: Ledger
  rules: Record<string, AccountRule>
  readings: ReadonlyMap<string, AccountReading>
  gate: GateContext
  /** Why `cwd` cannot be spawned into on `account`, or undefined when it can. */
  trust: (repo: string, cwd: string, account: string) => string | undefined
  capacity?: Capacity
  /** A leftover branch or worktree named for `agentName` that no claim accounts for. */
  orphan?: (repo: string, agentName: string) => string | undefined
  /** Why `work` collides with work landed, open or held in `repo` (CC-202), or undefined when it does not. */
  collision?: (repo: string, work: CollisionWork) => Collision | undefined
}

export interface Plan {
  dispatch: Dispatch[]
  refusals: Refusal[]
  /** Focused initiatives with no `autonomy: mode: burndown`, which the tick never reads further. */
  notOptedIn: string[]
  /** A seat plan's malformed open tasks the scorer left out; absent for the unseated plan. */
  skippedTasks?: string[]
}

/** A claim with no `namePrefix` names its agents `bd-...`, as every claim did before seats (CC-205). */
export const DEFAULT_NAME_PREFIX = 'bd'

/** The agent name, and so the worktree directory, a tick spawn for `taskId` (and `slice`) would use. */
export const agentNameFor = (taskId: string, slice?: string, prefix = DEFAULT_NAME_PREFIX): string =>
  `${prefix}-${taskId.toLowerCase()}${slice === undefined ? '' : `-${slice.toLowerCase()}`}`

/** The `attempt`th successor, which adopts the original's worktree rather than cutting its own. */
export const successorNameFor = (
  taskId: string,
  attempt: number,
  slice?: string,
  prefix = DEFAULT_NAME_PREFIX,
): string => `${agentNameFor(taskId, slice, prefix)}-s${attempt}`

export const reviewerNameFor = (
  taskId: string,
  round: number,
  slice?: string,
  prefix = DEFAULT_NAME_PREFIX,
): string => `${agentNameFor(taskId, slice, prefix)}-r${round}`

type OptedIn = Initiative & { autonomy: Autonomy }

export interface Tally {
  agents: number
  worktrees: Map<string, number>
}

export function plan(inputs: PlanInputs): Plan {
  const focused = inputs.initiatives.filter(i => i.state === 'focused').sort(byRank)
  const optedIn = focused.filter((i): i is OptedIn => i.autonomy !== undefined)
  const result: Plan = {
    dispatch: [],
    refusals: [],
    notOptedIn: focused.filter(i => i.autonomy === undefined).map(i => i.slug),
  }
  const tally: Tally = { agents: 0, worktrees: new Map() }
  for (const initiative of optedIn) {
    const outcome = planInitiative(initiative, inputs, tally)
    result.refusals.push(...outcome.refusals)
    if (outcome.dispatch !== undefined) result.dispatch.push(outcome.dispatch)
  }
  return result
}

function planInitiative(
  initiative: OptedIn,
  inputs: PlanInputs,
  tally: Tally,
): { dispatch?: Dispatch; refusals: Refusal[] } {
  const lanesHeld = laneClaims(inputs.ledger).filter(c => c.initiative === initiative.slug).length
  if (lanesHeld >= initiative.autonomy.lanes) {
    const reason = `${lanesHeld} of ${initiative.autonomy.lanes} lanes held`
    return { refusals: [{ initiative: initiative.slug, kind: 'lanes-full', reason }] }
  }
  const { work, refusals } = nextWork(initiative, inputs)
  if (work === undefined) return { refusals }
  const refuse = (r: Pick<Refusal, 'kind' | 'reason'>): Refusal => ({
    initiative: initiative.slug,
    task: work.taskId,
    ...r,
  })
  const placed = place(initiative, work, inputs)
  if ('kind' in placed) return { refusals: [...refusals, refuse(placed)] }
  const capped = capacityRefusal(placed, inputs.capacity, tally)
  if (capped !== undefined) return { refusals: [...refusals, refuse(capped)] }
  tally.agents += 1
  if (placed.worktree !== undefined)
    tally.worktrees.set(placed.repo, (tally.worktrees.get(placed.repo) ?? 0) + 1)
  return { dispatch: placed, refusals }
}

interface Work {
  taskId: string
  slice?: string
  profile: string
  /** A queued slice's claim prefix and seat, so its implementer shares the planner's. */
  namePrefix?: string
  seat?: string
}

/** A ready slice first, since its task is already underway; else the best eligible task with no orphan or collision. */
function nextWork(initiative: OptedIn, inputs: PlanInputs): { work?: Work; refusals: Refusal[] } {
  const tasks = inputs.tasks.get(initiative.slug) ?? []
  const held = backoffHeld(inputs.ledger, inputs.gate.now)
  const [ready] = readySlices(inputs.ledger, held).filter(c => c.initiative === initiative.slug)
  if (ready?.slice !== undefined) {
    const tags = tasks.find(t => t.id === ready.taskId)?.tags ?? []
    const work = { taskId: ready.taskId, slice: ready.slice, tags, owns: ready.owns ?? [] }
    const collided = collisionOf(initiative, work, inputs)
    if (collided !== undefined) return { refusals: [collided] }
    const identity = {
      ...(ready.namePrefix === undefined ? {} : { namePrefix: ready.namePrefix }),
      ...(ready.seat === undefined ? {} : { seat: ready.seat }),
    }
    return {
      work: { taskId: ready.taskId, slice: ready.slice, profile: IMPLEMENTER_PROFILE, ...identity },
      refusals: [],
    }
  }
  const claimed = new Set(heldClaims(inputs.ledger).map(c => c.taskId))
  const blocked: Refusal[] = []
  for (;;) {
    const skip = new Set(blocked.map(r => r.task))
    const { task, refusals } = pickTask(
      initiative,
      tasks.filter(t => !skip.has(t.id)),
      claimed,
      held,
    )
    if (task === undefined) return { refusals: [...blocked, ...refusals] }
    const profile = profileFor(task)
    const refusal =
      collisionOf(initiative, { taskId: task.id, tags: task.tags, owns: [] }, inputs) ??
      orphanRefusal(
        { initiative: initiative.slug, repo: initiative.autonomy.repo },
        task.id,
        profile,
        inputs.orphan,
      )
    if (refusal === undefined)
      return { work: { taskId: task.id, profile }, refusals: [...blocked, ...refusals] }
    blocked.push(refusal)
  }
}

function collisionOf(initiative: OptedIn, work: CollisionWork, inputs: PlanInputs): Refusal | undefined {
  const repo = initiative.autonomy.repo
  if (repo === undefined || inputs.collision === undefined) return undefined
  const found = inputs.collision(repo, work)
  return found === undefined ? undefined : { initiative: initiative.slug, task: work.taskId, ...found }
}

/** A failed spawn leaves its branch and worktree with no claim; dispatching onto it would adopt stale work. */
export function orphanRefusal(
  at: { initiative: string; repo: string | undefined; prefix?: string | undefined },
  taskId: string,
  profile: string,
  orphan: PlanInputs['orphan'],
): Refusal | undefined {
  if (profile === PLANNER_PROFILE || at.repo === undefined || orphan === undefined) return undefined
  const reason = orphan(at.repo, agentNameFor(taskId, undefined, at.prefix))
  return reason === undefined
    ? undefined
    : { initiative: at.initiative, task: taskId, kind: 'orphan', reason }
}

/** The account, profile and worktree for eligible work, or why there is none. */
function place(
  initiative: OptedIn,
  work: Work,
  inputs: PlanInputs,
): Dispatch | Pick<Refusal, 'kind' | 'reason'> {
  const named = initiative.autonomy.accounts.length > 0 ? initiative.autonomy.accounts : [initiative.profile]
  const allowed = named.filter((a): a is string => a !== undefined)
  if (allowed.length === 0) return { kind: 'no-account', reason: 'no autonomy.accounts and no profile' }

  const { chosen, closed } = pickAccount(allowed, inputs.rules, inputs.readings, inputs.gate)
  if (chosen === undefined)
    return { kind: 'budget', reason: closed.map(c => `${c.account}: ${c.reason}`).join('; ') }
  const { profile } = work
  if (chosen.sonnetOnly && !SONNET_PROFILES.has(profile))
    return {
      kind: 'budget',
      reason: `${chosen.account} is above 85% seven_day, sonnet only; task needs ${profile}`,
    }

  const repo = initiative.autonomy.repo
  if (repo === undefined) return { kind: 'trust', reason: 'no autonomy.repo, so no worktree path to check' }
  const agentName = agentNameFor(work.taskId, work.slice, work.namePrefix)
  // A planner runs with isolation none in the checkout itself, so trust is checked on the repo.
  const worktree = profile === PLANNER_PROFILE ? undefined : worktreePathFor(repo, agentName)
  const cwd = worktree ?? repo
  const untrusted = inputs.trust(repo, cwd, chosen.account)
  if (untrusted !== undefined) return { kind: 'trust', reason: untrusted }

  const task = inputs.tasks.get(initiative.slug)?.find(t => t.id === work.taskId)
  const reason = `priority ${task?.priority ?? '-'}, estimate ${task?.estimate ?? '-'}; ${chosen.account} ${chosen.reason}`
  return {
    initiative: initiative.slug,
    task: work.taskId,
    ...(work.slice === undefined ? {} : { slice: work.slice }),
    profile,
    account: chosen.account,
    cwd,
    repo,
    agentName,
    ...(worktree === undefined ? {} : { worktree }),
    reason,
    ...(work.namePrefix === undefined ? {} : { namePrefix: work.namePrefix }),
    ...(work.seat === undefined ? {} : { seat: work.seat }),
  }
}

export function capacityRefusal(
  d: Pick<Dispatch, 'repo' | 'worktree'>,
  capacity: Capacity | undefined,
  tally: Tally,
): Pick<Refusal, 'kind' | 'reason'> | undefined {
  if (capacity === undefined) return undefined
  if (tally.agents >= capacity.agents) return { kind: 'slots', reason: capacity.agentsReason }
  if (d.worktree === undefined) return undefined
  const use = capacity.worktrees(d.repo)
  const added = tally.worktrees.get(d.repo) ?? 0
  const where = `${d.repo}/.worktrees`
  if (use.total + added >= use.totalCeiling)
    return {
      kind: 'worktrees',
      reason: `${use.total + added} worktrees under ${where}; the tick stops at ${use.totalCeiling} (budget less reserve)`,
    }
  if (use.ours + added >= use.oursCeiling)
    return {
      kind: 'worktrees',
      reason: `${use.ours + added} burndown worktrees under ${where}; maxWorktreesPerRepo is ${use.oursCeiling}`,
    }
  return undefined
}
