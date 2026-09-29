import path from 'node:path'
import { claimKey, type Action, type ClaimKey } from './advance.js'
import {
  planPathFor,
  plannerBrief,
  reviewerBrief,
  successorAfterAnswer,
  successorAfterReview,
  workerBrief,
  type TaskBrief,
} from './brief.js'
import { IMPLEMENTER_PROFILE, PLANNER_PROFILE, type Initiative, type Task } from './eligibility.js'
import { spawnFrame, type SpawnFrame, type Step } from './execute.js'
import { heldClaims, sameClaim, type Claim, type Ledger } from './ledger.js'
import { rowNamed, type Roster } from './observe.js'
import type { Dispatch } from './plan.js'
import { parseSlices } from './report.js'
import { chargesOn, type PoolGateResult } from './budget-gate.js'
import type { SeatDispatch } from './seat-dispatch.js'

/**
 * Turns what `advance` and `plan` decided into executable steps: a brief built
 * from templates, an account the budget gate opened, and a spawn frame. The
 * intent (a ledger write) always comes before its spawn in the output.
 */

export const REVIEWER_PROFILE = 'bd-reviewer'

export interface StepContext {
  now: Date
  root: string
  initiatives: ReadonlyMap<string, Initiative>
  tasks: ReadonlyMap<string, Task[]>
  reportTo: string
  repoFacts: (repo: string) => { defaultBranch: string; verifySteps?: string }
  /** The account the budget gate opens for an initiative right now, or why none is open. */
  account: (initiative: Initiative) => { account: string } | { closed: string }
  configDir: (account: string) => string
  trust: (repo: string, cwd: string, account: string) => string | undefined
  taskText: (slug: string, taskId: string) => string | undefined
  readFile: (file: string) => string | undefined
  /** Seats mode only: a listed seat's spawn inputs, why a listed seat is out this tick, or undefined for a seat not listed. */
  seat?: (name: string) => SeatSpawn | { skipped: string } | undefined
}

export interface SeatSpawn {
  dispatch: SeatDispatch
  /** The pool gate with `dispatched` spawns already charged to the pool this tick. */
  gate: (dispatched: number) => PoolGateResult
  trust: (repo: string, cwd: string, configDir: string) => string | undefined
}

export interface Resolved {
  steps: Step[]
  spawns: number
  /** Claims left untouched this tick, and why; the same actions come back next tick. */
  deferred: string[]
  /** The pool each seat spawn billed, one entry per spawn, so later gates this tick see the charge. */
  charged: string[]
}

type SpawnAction = Extract<Action, { kind: 'spawn' }>
type Outcome = { frame: SpawnFrame; pool?: string } | { defer: string } | { stall: string }

/** Groups each claim's actions so a deferred spawn also drops the intent write that precedes it. */
export function stepsForActions(
  actions: Action[],
  ledger: Ledger,
  ctx: StepContext,
  budget: number,
): Resolved {
  const groups = new Map<string, Action[]>()
  for (const action of actions) {
    const key = action.kind === 'add' ? `add:${groups.size}` : claimKey(action.key)
    groups.set(key, [...(groups.get(key) ?? []), action])
  }
  const resolved: Resolved = { steps: [], spawns: 0, deferred: [], charged: [] }
  for (const [key, group] of groups) {
    const spawn = group.find((a): a is SpawnAction => a.kind === 'spawn')
    if (spawn === undefined) {
      resolved.steps.push(...plainSteps(group))
      continue
    }
    const outcome =
      resolved.spawns >= budget
        ? { defer: 'no agent capacity left this tick' }
        : resolveSpawn(spawn, ledger, ctx, resolved.charged)
    if ('defer' in outcome) resolved.deferred.push(`${key}: ${outcome.defer}`)
    else if ('stall' in outcome) resolved.steps.push(ledgerStep(stallUpdate(spawn.key, outcome.stall)))
    else {
      resolved.steps.push(...plainSteps(group.filter(a => a !== spawn)))
      resolved.steps.push({ kind: 'spawn', key: spawn.key, frame: outcome.frame })
      resolved.spawns += 1
      if (outcome.pool !== undefined) resolved.charged.push(outcome.pool)
    }
  }
  return resolved
}

const ledgerStep = (...actions: Action[]): Step => ({ kind: 'ledger', actions })

const stallUpdate = (key: ClaimKey, reason: string): Action => ({
  kind: 'update',
  key,
  patch: { stalledReason: reason },
})

function plainSteps(actions: Action[]): Step[] {
  return actions.flatMap((a): Step[] => {
    if (a.kind === 'retire') return [{ kind: 'retire', key: a.key, names: a.names }]
    if (a.kind === 'spawn') return []
    return [ledgerStep(a)]
  })
}

/** What a spawn for a held claim runs on: its placement, the gate's verdict, and the trust check. */
interface SpawnSetup {
  initiative: Initiative
  repo: string | undefined
  placement: (account: string) => Placement
  gate: { account: string } | { closed: string }
  /** The seat pool a spawn bills; absent for an autonomy account. */
  pool?: string
  trust: (repo: string, cwd: string, account: string) => string | undefined
}

function autonomySetup(initiative: Initiative, ctx: StepContext): SpawnSetup {
  const repo = initiative.autonomy?.repo
  return {
    initiative,
    repo,
    placement: account => autonomyPlacement(repo, account, initiative, ctx),
    gate: ctx.account(initiative),
    trust: ctx.trust,
  }
}

/** A seat claim's placement and pool gate come from the seat; reviewers and successors run on opus, so sonnet-only closes them. */
function seatSetup(
  claim: Claim,
  seat: SeatSpawn,
  initiative: Initiative,
  charged: readonly string[],
): SpawnSetup {
  const { dispatch } = seat
  const gate = seat.gate(chargesOn(dispatch.pool.name, charged))
  const repos = dispatch.repos[initiative.slug] ?? []
  const repo = repos.find(r => claim.worktree?.startsWith(`${r}${path.sep}`)) ?? repos[0]
  const placement: Placement = { repo, configDir: dispatch.configDir, grants: dispatch.grants }
  const closed = !gate.open
    ? gate.reason
    : gate.sonnetOnly
      ? `${gate.pool} is within 10 points of a stop, sonnet only`
      : undefined
  return {
    initiative,
    repo,
    placement: () => placement,
    gate: closed === undefined ? { account: dispatch.configDir } : { closed },
    pool: dispatch.pool.name,
    trust: (r, cwd) => seat.trust(r, cwd, dispatch.configDir),
  }
}

function spawnSetup(
  claim: Claim,
  ctx: StepContext,
  charged: readonly string[],
): SpawnSetup | { stall: string } | { defer: string } {
  const initiative = ctx.initiatives.get(claim.initiative)
  if (initiative === undefined) return { stall: 'initiative is no longer opted in with a repo' }
  if (claim.seat === undefined) return autonomySetup(initiative, ctx)
  const seat = ctx.seat?.(claim.seat)
  if (seat === undefined)
    return { stall: `seat ${claim.seat} is no longer in the burndown config; left for the owner` }
  if ('skipped' in seat) return { defer: `seat ${claim.seat} skipped this tick: ${seat.skipped}` }
  return seatSetup(claim, seat, initiative, charged)
}

function resolveSpawn(
  action: SpawnAction,
  ledger: Ledger,
  ctx: StepContext,
  charged: readonly string[],
): Outcome {
  const claim = heldClaims(ledger).find(c => sameClaim(c, action.key))
  if (claim === undefined) return { stall: 'initiative is no longer opted in with a repo' }
  const setup = spawnSetup(claim, ctx, charged)
  if ('stall' in setup || 'defer' in setup) return setup
  const { initiative, repo, gate } = setup
  if (repo === undefined) return { stall: 'initiative is no longer opted in with a repo' }
  if (claim.worktree === undefined) return { stall: 'no worktree recorded for the claim' }
  if ('closed' in gate) return { defer: `budget: ${gate.closed}` }
  const untrusted = setup.trust(repo, claim.worktree, gate.account)
  if (untrusted !== undefined) return { stall: `trust: ${untrusted}` }
  const t = taskBrief(claim.taskId, claim.slice, initiative, setup.placement(gate.account), ctx)
  if (typeof t === 'string') return { stall: t }
  const spec = {
    name: action.name,
    configDir: t.configDir,
    initiative: initiative.slug,
    taskId: claim.taskId,
  }
  const frame =
    action.role === 'reviewer'
      ? spawnFrame({
          ...spec,
          profile: REVIEWER_PROFILE,
          brief: reviewerBrief({ ...t, implementer: claim.agentName ?? '?' }),
          cwd: claim.worktree,
        })
      : successorFrame(action, t, spec, repo)
  return { frame, ...(setup.pool === undefined ? {} : { pool: setup.pool }) }
}

function successorFrame(
  action: SpawnAction,
  t: TaskBrief,
  spec: { name: string; configDir: string; initiative: string; taskId: string },
  repo: string,
): SpawnFrame {
  const context = action.context
  const brief =
    context?.kind === 'answer'
      ? successorAfterAnswer(t, {
          question: `message ${context.questionId}; your predecessor's handoff restates it`,
          answer: context.answer.text,
          provenance: context.answer.provenance === 'decided' ? 'decided' : 'human',
        })
      : successorAfterReview(t, context?.kind === 'review' ? context.review : 'no review text was readable')
  return spawnFrame({
    ...spec,
    profile: IMPLEMENTER_PROFILE,
    brief,
    cwd: repo,
    ...(action.predecessor === undefined ? {} : { predecessor: action.predecessor }),
    ...(action.worktree === undefined ? {} : { worktree: action.worktree }),
  })
}

/** Where a brief's agent works and what it may do: an initiative's autonomy block, or a seat's dispatch. */
interface Placement {
  repo: string | undefined
  configDir: string
  grants: string[]
}

const autonomyPlacement = (
  repo: string | undefined,
  account: string,
  initiative: Initiative,
  ctx: StepContext,
): Placement => ({ repo, configDir: ctx.configDir(account), grants: initiative.autonomy?.grants ?? [] })

function dispatchPlacement(d: Dispatch, initiative: Initiative, ctx: StepContext): Placement {
  if (d.seat === undefined) return autonomyPlacement(initiative.autonomy?.repo, d.account, initiative, ctx)
  return { repo: d.repo, configDir: d.configDir ?? ctx.configDir(d.account), grants: d.grants ?? [] }
}

/** Everything a worker, planner or successor brief needs, or why it cannot be built. */
function taskBrief(
  taskId: string,
  slice: string | undefined,
  initiative: Initiative,
  { repo, configDir, grants }: Placement,
  ctx: StepContext,
): TaskBrief | string {
  const task = ctx.tasks.get(initiative.slug)?.find(t => t.id === taskId)
  const taskYml = ctx.taskText(initiative.slug, taskId)
  if (repo === undefined || task?.doneWhen === undefined || taskYml === undefined)
    return `task file for ${taskId} is gone or has no done_when`
  const initiativeDir = path.join(ctx.root, initiative.slug)
  const facts = ctx.repoFacts(repo)
  return {
    reportTo: ctx.reportTo,
    configDir,
    defaultBranch: facts.defaultBranch,
    ...(facts.verifySteps === undefined ? {} : { verifySteps: facts.verifySteps }),
    initiative: initiative.slug,
    initiativeDir,
    taskId,
    taskYml,
    doneWhen: task.doneWhen,
    grants,
    ...(slice === undefined ? {} : { slice: sliceInfo(initiativeDir, taskId, slice, ctx) }),
  }
}

function sliceInfo(
  initiativeDir: string,
  taskId: string,
  n: string,
  ctx: StepContext,
): NonNullable<TaskBrief['slice']> {
  const planPath = planPathFor(initiativeDir, taskId)
  const text = ctx.readFile(planPath)
  const title = (text === undefined ? undefined : parseSlices(text))?.find(s => s.n === n)?.title
  return { n, title: title ?? `slice ${n}`, planPath }
}

/**
 * CC-182: a done claim's refused retires, tried again in their recorded order. A name
 * already retired by hand, reused by a held claim, or now carried by an agent spawned
 * after the refusal (CC-185) is dropped, and a step with no names left just clears the record.
 */
export function retrySteps(ledger: Ledger, roster: Roster): Step[] {
  const reused = new Set(heldClaims(ledger).flatMap(c => c.spawned ?? []))
  const pending = (u: Unretired): boolean => {
    const row = rowNamed(roster, u.name)
    if (reused.has(u.name) || row === undefined || row.state === 'retired') return false
    return u.at === undefined || row.spawnedAt <= Date.parse(u.at)
  }
  return ledger.claims
    .filter(c => c.phase === 'done' && (c.unretired?.length ?? 0) > 0)
    .map(c => ({
      kind: 'retire',
      key: c.slice === undefined ? { taskId: c.taskId } : { taskId: c.taskId, slice: c.slice },
      names: (c.unretired ?? []).filter(pending).map(u => u.name),
    }))
}

type Unretired = NonNullable<Claim['unretired']>[number]

/** A new claim (or a queued slice moved to `spawning`), then its spawn; or why it cannot go. */
export function stepsForDispatch(d: Dispatch, ctx: StepContext): Step[] | string {
  const initiative = ctx.initiatives.get(d.initiative)
  if (initiative === undefined) return `initiative ${d.initiative} vanished mid-tick`
  const t = taskBrief(d.task, d.slice, initiative, dispatchPlacement(d, initiative, ctx), ctx)
  if (typeof t === 'string') return t
  const planner = d.profile === PLANNER_PROFILE
  const key: ClaimKey = d.slice === undefined ? { taskId: d.task } : { taskId: d.task, slice: d.slice }
  const at = ctx.now.toISOString()
  const intent = {
    phase: 'spawning' as const,
    phaseAt: at,
    spawnedAt: at,
    nextPhase: planner ? ('planning' as const) : ('implementing' as const),
    agentName: d.agentName,
    spawned: [d.agentName],
    ...(d.worktree === undefined ? {} : { worktree: d.worktree }),
    ...(d.seat === undefined ? {} : { seat: d.seat }),
    ...(d.namePrefix === undefined ? {} : { namePrefix: d.namePrefix }),
  }
  const write: Action =
    d.slice === undefined
      ? { kind: 'add', claims: [{ taskId: d.task, initiative: d.initiative, ...intent }] }
      : { kind: 'update', key, patch: intent }
  const frame = spawnFrame({
    name: d.agentName,
    profile: d.profile,
    brief: planner ? plannerBrief(t) : workerBrief(t),
    cwd: d.repo,
    configDir: t.configDir,
    initiative: d.initiative,
    taskId: d.task,
  })
  return [ledgerStep(write), { kind: 'spawn', key, frame }]
}
