import type { Autonomy } from '../active-work.js'
import { contractOverlap, type Collision, type CollisionWork, type HeldContracts } from './collision.js'
import type { Contract } from './report.js'
import { pickAccount, type AccountReading, type AccountRule, type GateContext } from './budget-gate.js'
import {
  byRank,
  IMPLEMENTER_PROFILE,
  pickTask,
  PLANNER_PROFILE,
  sliceRefusal,
  isBriefer,
  profileFor,
  SONNET_PROFILES,
  type Initiative,
  type Refusal,
  type Task,
} from './eligibility.js'
import { backoffHeld, type Hold } from './backoff.js'
import { capGate, type GateReading } from './gate-reading.js'
import { BRANCH_PREFIX } from '../isolation/worktree.js'
import {
  heldClaims,
  laneClaims,
  readySlices,
  type Claim,
  type Ledger,
  type StackedOn,
  type StackPredicate,
} from './ledger.js'
import type { ShepherdRow } from './shepherd.js'
import { stackable, stackReady, type StackMode } from './stack.js'
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
  /** CC-939: a planner-profile spawn that writes the task's brief. */
  briefer?: boolean
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
  /** CC-952: the slice's declared owns, claimed for the agent at spawn. */
  owns?: string[]
  /** CC-1158: the unmerged parent a slice is stacked on; its worktree and PR start from the parent's branch. */
  stackedOn?: StackedOn
}

/** Implementer worktrees under one repo's `.worktrees`: every one, and those the tick's own agents hold. */
export interface WorktreeUse {
  total: number
  ours: number
  /** Reviewer trees, charged to the broker's reviewer pool and not to `total` (CC-1040). */
  reviewers?: number
  /** The broker's per-repo budget less the reserve the tick never takes. */
  totalCeiling: number
  oursCeiling: number
}

/** The tick's own ceilings, under the broker's; `burndown plan` never spawns and passes none. */
export interface Capacity {
  /** New agents this run may still start, after `maxAgents` and the broker's free slots. */
  agents: number
  agentsReason: string
  /** CC-1097: the agent ceiling that binds with `room` of `agents` left to start (0 or less when refused). */
  agentsGate: (room: number) => GateReading
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
  /** `landedRepos` are the other checkouts whose default branch also counts as landing the task (a seat's repos). */
  collision?: (repo: string, work: CollisionWork, landedRepos?: readonly string[]) => Collision | undefined
  /** CC-1158: admits a queued slice onto its one unmerged parent under `stack.mode: on`; absent, none stacks. */
  stack?: StackPredicate
}

export interface Plan {
  dispatch: Dispatch[]
  refusals: Refusal[]
  /** Focused initiatives with no `autonomy: mode: burndown`, which the tick never reads further. */
  notOptedIn: string[]
  /** A seat plan's malformed open tasks the scorer left out; absent for the unseated plan. */
  skippedTasks?: string[]
  /** A seat plan's service-check state, printed under the header; absent for the unseated plan. */
  serviceCheck?: string
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
  const accepted: HeldContracts[] = []
  for (const initiative of optedIn) {
    const outcome = planInitiative(initiative, inputs, tally, accepted)
    result.refusals.push(...outcome.refusals)
    if (outcome.dispatch !== undefined) result.dispatch.push(outcome.dispatch)
  }
  return result
}

function planInitiative(
  initiative: OptedIn,
  inputs: PlanInputs,
  tally: Tally,
  accepted: HeldContracts[],
): { dispatch?: Dispatch; refusals: Refusal[] } {
  const lanesHeld = laneClaims(inputs.ledger).filter(c => c.initiative === initiative.slug).length
  if (lanesHeld >= initiative.autonomy.lanes) {
    const reason = `${lanesHeld} of ${initiative.autonomy.lanes} lanes held`
    return { refusals: [{ initiative: initiative.slug, kind: 'lanes-full', reason }] }
  }
  const { work, refusals } = nextWork(initiative, inputs, accepted)
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
  if (work.contracts !== undefined) accepted.push({ holder: placed.agentName, contracts: work.contracts })
  if (placed.worktree !== undefined)
    tally.worktrees.set(placed.repo, (tally.worktrees.get(placed.repo) ?? 0) + 1)
  return { dispatch: placed, refusals }
}

interface Work {
  taskId: string
  slice?: string
  profile: string
  briefer?: boolean
  /** A queued slice's claim prefix and seat, so its implementer shares the planner's. */
  namePrefix?: string
  seat?: string
  contracts?: Contract[]
  stackedOn?: StackedOn
}

/** A ready slice first, since its task is already underway; else the best eligible task with no orphan or collision. */
function nextWork(
  initiative: OptedIn,
  inputs: PlanInputs,
  accepted: readonly HeldContracts[],
): { work?: Work; refusals: Refusal[] } {
  const tasks = inputs.tasks.get(initiative.slug) ?? []
  const held = backoffHeld(inputs.ledger, inputs.gate.now)
  const gated: Refusal[] = []
  const ready = readySlices(inputs.ledger, held, inputs.stack).filter(
    (c): c is Claim & { slice: string } => c.initiative === initiative.slug && c.slice !== undefined,
  )
  for (const slice of ready) {
    const task = tasks.find(t => t.id === slice.taskId)
    const refusal = sliceRefusal(task, [])
    if (refusal !== undefined) {
      gated.push({ initiative: initiative.slug, task: slice.taskId, ...refusal })
      continue
    }
    const outcome = sliceWork(initiative, slice, task?.tags ?? [], inputs, accepted)
    return { ...outcome, refusals: [...gated, ...outcome.refusals] }
  }
  const picked = nextTask(initiative, tasks, inputs, accepted, held)
  return { ...picked, refusals: [...gated, ...picked.refusals] }
}

/** The implementer for a ready slice whose parent passed `sliceRefusal`, or its collision. */
function sliceWork(
  initiative: OptedIn,
  ready: Claim & { slice: string },
  tags: string[],
  inputs: PlanInputs,
  accepted: readonly HeldContracts[],
): { work?: Work; refusals: Refusal[] } {
  const work = {
    taskId: ready.taskId,
    slice: ready.slice,
    tags,
    owns: ready.owns ?? [],
    contracts: ready.contracts ?? [],
    ...(ready.stackedOn === undefined ? {} : { stackedOn: ready.stackedOn }),
  }
  const collided = collisionOf(initiative, work, inputs, accepted)
  if (collided !== undefined) return { refusals: [collided] }
  const identity = {
    ...(ready.namePrefix === undefined ? {} : { namePrefix: ready.namePrefix }),
    ...(ready.seat === undefined ? {} : { seat: ready.seat }),
  }
  return {
    work: {
      taskId: ready.taskId,
      slice: ready.slice,
      profile: IMPLEMENTER_PROFILE,
      contracts: work.contracts,
      ...identity,
      ...(ready.stackedOn === undefined ? {} : { stackedOn: ready.stackedOn }),
    },
    refusals: [],
  }
}

/** The best eligible task with no orphan or collision. */
function nextTask(
  initiative: OptedIn,
  tasks: Task[],
  inputs: PlanInputs,
  accepted: readonly HeldContracts[],
  held: ReadonlyMap<string, Hold>,
): { work?: Work; refusals: Refusal[] } {
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
      collisionOf(initiative, { taskId: task.id, tags: task.tags, owns: [] }, inputs, accepted) ??
      orphanRefusal(
        { initiative: initiative.slug, repo: initiative.autonomy.repo },
        task.id,
        profile,
        inputs.orphan,
        inputs.ledger,
      )
    if (refusal === undefined)
      return {
        work: { taskId: task.id, profile, ...(isBriefer(task) ? { briefer: true } : {}) },
        refusals: [...blocked, ...refusals],
      }
    blocked.push(refusal)
  }
}

function collisionOf(
  initiative: OptedIn,
  work: CollisionWork,
  inputs: PlanInputs,
  accepted: readonly HeldContracts[],
): Refusal | undefined {
  const repo = initiative.autonomy.repo
  if (repo === undefined || inputs.collision === undefined) return undefined
  const found = inputs.collision(repo, work) ?? contractOverlap(work, accepted)
  return found === undefined ? undefined : { initiative: initiative.slug, task: work.taskId, ...found }
}

/** A failed spawn leaves its branch and worktree with no claim; dispatching onto it would adopt stale work. */
export function orphanRefusal(
  at: { initiative: string; repo: string | undefined; prefix?: string | undefined },
  taskId: string,
  profile: string,
  orphan: PlanInputs['orphan'],
  ledger?: Ledger,
): Refusal | undefined {
  if (profile === PLANNER_PROFILE || at.repo === undefined || orphan === undefined) return undefined
  const name = agentNameFor(taskId, undefined, at.prefix)
  // The branch a ladder release kept (CC-698) is the prior attempt, not an orphan: the re-dispatch adopts it.
  if (ledger?.ladder?.[`${taskId}#`]?.branch === `${BRANCH_PREFIX}${name}`) return undefined
  const reason = orphan(at.repo, name)
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
    ...(work.briefer === true ? { briefer: true } : {}),
    account: chosen.account,
    cwd,
    repo,
    agentName,
    ...(worktree === undefined ? {} : { worktree }),
    reason,
    ...(work.namePrefix === undefined ? {} : { namePrefix: work.namePrefix }),
    ...(work.seat === undefined ? {} : { seat: work.seat }),
    ...(work.stackedOn === undefined ? {} : { stackedOn: work.stackedOn }),
  }
}

/** CC-1158: under `on`, the predicate the planners stack slices with; under `shadow`, would-stack notes only. */
export function stackInputs(
  mode: StackMode,
  ledger: Ledger,
  held: ReadonlyMap<string, unknown>,
  rows: () => readonly ShepherdRow[] | undefined,
): { stack?: StackPredicate; notes: string[] } {
  if (mode === 'off') return { notes: [] }
  const read = rows()
  if (read === undefined)
    return { notes: [`stack ${mode}: shepherd status unread, so nothing stacks this tick`] }
  if (mode === 'shadow') return { notes: stackReady(mode, ledger, held, read).notes }
  return { stack: (child, dep) => stackable(child, dep, ledger, read), notes: [] }
}

const WORKTREE_BUDGET_SOURCE = '~/.agent-chat/config.json'
/** Where the tick's own ceilings (`maxAgents`, `maxWorktreesPerRepo`) are set. */
export const BURNDOWN_CONFIG = 'burndown.config.json'

export function capacityRefusal(
  d: Pick<Dispatch, 'repo' | 'worktree'>,
  capacity: Capacity | undefined,
  tally: Tally,
): Pick<Refusal, 'kind' | 'reason' | 'gate'> | undefined {
  if (capacity === undefined) return undefined
  if (tally.agents >= capacity.agents)
    return {
      kind: 'slots',
      reason: capacity.agentsReason,
      gate: capacity.agentsGate(capacity.agents - tally.agents),
    }
  if (d.worktree === undefined) return undefined
  const use = capacity.worktrees(d.repo)
  const added = tally.worktrees.get(d.repo) ?? 0
  const where = `${d.repo}/.worktrees`
  if (use.total + added >= use.totalCeiling)
    return {
      kind: 'worktrees',
      reason:
        `${use.total + added} worktrees under ${where}: implementer pool full ` +
        `(${use.reviewers ?? 0} reviewer trees not counted); the tick stops at ${use.totalCeiling} (budget less reserve)`,
      gate: capGate('worktreeBudget', use.totalCeiling, use.total + added, WORKTREE_BUDGET_SOURCE),
    }
  if (use.ours + added >= use.oursCeiling)
    return {
      kind: 'worktrees',
      reason: `implementer pool: ${use.ours + added} burndown worktrees under ${where}; maxWorktreesPerRepo is ${use.oursCeiling}`,
      gate: capGate('burndown.maxWorktreesPerRepo', use.oursCeiling, use.ours + added, BURNDOWN_CONFIG),
    }
  return undefined
}
