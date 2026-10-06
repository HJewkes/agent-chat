import type { AgentLifecycle, DeliveredMessage } from '../../protocol.js'
import type { ExceptionClass } from './exception.js'
import { addClaim, isStalled, sameClaim, type AgentPhase, type Claim, type Ledger } from './ledger.js'
import { agentNameFor, reviewerNameFor, successorNameFor } from './plan.js'
import type { Progress } from './progress.js'
import type { PlannedSlice, Report } from './report.js'
import { shepherdTarget, type Registration, type ShepherdRow } from './shepherd.js'
import type { ClaimSpend } from './spend-cap.js'
import type { ActivityRead } from './stall.js'
import type { StallCode } from './stall-code.js'

/**
 * The tick's phase machine: given every claim and what the tick observed
 * about it, the actions that move each claim one phase. Pure: the caller
 * reads the roster, inbox, transcript, diff and Shepherd, and executes the actions
 * in order, writing each `update` before the `spawn` that follows it.
 */

export type ClaimKey = Pick<Claim, 'taskId' | 'slice'>
export type InboxMessage = Pick<DeliveredMessage, 'msgId' | 'from' | 'text' | 'provenance' | 'inReplyTo'>

export interface Observation {
  /** The roster row named `claim.agentName`, absent when there is none. */
  agent?: { id: string; state: AgentLifecycle }
  /** The parsed final message of that agent. */
  report?: Report
  /** Messages to the parked worker since the claim's inbox cursor. */
  inbox?: InboxMessage[]
  /** A finished planner's slices, parsed from its plan file. */
  slices?: PlannedSlice[]
  /** CC-631: why a finished planner's slices were refused, one line per slice and rule. */
  sliceProblems?: string[]
  /** A live lane agent's transcript read for the stall check, with the row's spawn time (CC-654). */
  activity?: { read: ActivityRead; spawnedAt: number }
  /** A live implementer's worktree HEAD and uncommitted hash (CC-659); read, not yet acted on. */
  progress?: Progress | 'unreadable'
  diff?: { reviewable: boolean; reason: string }
  /** Shepherd's row for the claim's PR, absent from the row when Shepherd has none; `landed` is read for a finished run. */
  shepherd?: { row?: ShepherdRow; landed?: boolean }
  /** CC-723: the claim's transcript spend over every agent it spawned, against its seat's `per_claim_usd`; read, not yet acted on. */
  spend?: { claim: ClaimSpend; cap: number }
}

export type SpawnContext =
  { kind: 'answer'; questionId: string; answer: InboxMessage } | { kind: 'review'; review: string }

type ClaimPatch = Partial<Omit<Claim, 'taskId' | 'slice' | 'initiative'>>

export type Action =
  | { kind: 'update'; key: ClaimKey; patch: ClaimPatch }
  | {
      kind: 'spawn'
      key: ClaimKey
      role: 'reviewer' | 'successor'
      name: string
      predecessor?: string
      worktree?: string
      context?: SpawnContext
    }
  /** Retire in the order given: successors and reviewers first, the original agent last (CC-141). */
  | { kind: 'retire'; key: ClaimKey; names: string[] }
  | { kind: 'add'; claims: Claim[] }
  /** Hands the claim's PR to Shepherd, after the update that moves it to `shepherding`. */
  | { kind: 'register'; key: ClaimKey; registration: Registration }

export const claimKey = (c: ClaimKey): string => `${c.taskId}#${c.slice ?? ''}`

export function advance(
  claims: Claim[],
  observations: ReadonlyMap<string, Observation>,
  now: Date,
): Action[] {
  return claims.flatMap(claim => advanceClaim(claim, observations.get(claimKey(claim)) ?? {}, now))
}

type Step = (claim: Claim, obs: Observation, now: Date) => Action[]

const STEPS: Partial<Record<Claim['phase'], Step>> = {
  spawning: (claim, obs) => (obs.agent === undefined ? [] : [landed(claim, obs.agent.id)]),
  planning: (claim, obs, now) => (finished(obs) ? afterPlanner(claim, obs, now) : []),
  implementing: (claim, obs) => (finished(obs) ? afterWorker(claim, obs) : []),
  parked: afterAnswer,
  reviewing: (claim, obs) => (finished(obs) ? afterReviewer(claim, obs) : []),
  'awaiting-merge': afterMerge,
  shepherding: afterMerge,
}

function advanceClaim(claim: Claim, obs: Observation, now: Date): Action[] {
  if (claim.phase === 'done' || claim.stalledReason !== undefined) return []
  const actions = STEPS[claim.phase]?.(claim, obs, now) ?? []
  if (actions.length > 0 || !isStalled(claim, now)) return actions
  return [
    claim.phase === 'spawning'
      ? stall(
          claim,
          `no agent row named ${claim.agentName ?? '?'}; the spawn failed or never landed`,
          'stalled',
          'spawn-never-landed',
        )
      : stall(claim, `${claim.phase} past its timeout`, 'stalled', 'phase-timeout'),
  ]
}

const finished = (obs: Observation): boolean =>
  obs.agent?.state === 'exited' || obs.agent?.state === 'retired'

const update = (claim: Claim, patch: ClaimPatch): Action => ({ kind: 'update', key: keyOf(claim), patch })

const stall = (claim: Claim, reason: string, cls: ExceptionClass, code?: StallCode): Action =>
  update(claim, {
    stalledReason: reason,
    stalledClass: cls,
    ...(code === undefined ? {} : { stallCode: code }),
  })

const keyOf = (claim: Claim): ClaimKey => ({ taskId: claim.taskId, slice: claim.slice })

const landed = (claim: Claim, agentId: string): Action =>
  update(claim, { phase: claim.nextPhase ?? 'implementing', agentId, nextPhase: undefined })

function afterPlanner(claim: Claim, obs: Observation, now: Date): Action[] {
  if (obs.slices === undefined)
    return [stall(claim, sliceStallReason(obs.sliceProblems), 'failed', 'planner-refused')]
  const at = now.toISOString()
  const slices: Claim[] = obs.slices.map(s => ({
    taskId: claim.taskId,
    initiative: claim.initiative,
    spawnedAt: at,
    phase: 'queued',
    phaseAt: at,
    slice: s.n,
    dependsOn: s.dependsOn,
    ...(s.owns.length === 0 ? {} : { owns: s.owns }),
    ...((s.contracts ?? []).length === 0 ? {} : { contracts: s.contracts }),
    ...seatOf(claim),
  }))
  return [update(claim, { phase: 'done' }), { kind: 'add', claims: slices }, retireAll(claim)]
}

const sliceStallReason = (problems: string[] | undefined): string =>
  problems === undefined || problems.length === 0
    ? 'planner left no machine-readable slices'
    : problems.join('\n')

/** A slice keeps its planner's seat and name prefix, so its agents are named and counted as the seat's. */
const seatOf = (claim: Claim): Pick<Claim, 'seat' | 'namePrefix'> => ({
  ...(claim.seat === undefined ? {} : { seat: claim.seat }),
  ...(claim.namePrefix === undefined ? {} : { namePrefix: claim.namePrefix }),
})

function afterWorker(claim: Claim, obs: Observation): Action[] {
  const report = obs.report
  const lastReport = report?.firstLine
  if (report?.parked !== undefined)
    return [update(claim, { phase: 'parked', questionId: report.parked, lastReport })]
  if (report?.status === 'BLOCKED' || report?.status === 'NEEDS_CONTEXT')
    return [stall(claim, report.firstLine, 'failed')]
  const pr = report?.pr ?? claim.pr
  if (report?.status === 'DONE' && pr !== undefined)
    return handOff(claim, pr, claim.agentName ?? workerOf(claim), { lastReport })
  if (obs.diff?.reviewable === true) {
    const name = reviewerNameFor(claim.taskId, claim.reviewRound ?? 0, claim.slice, claim.namePrefix)
    return spawn(claim, { role: 'reviewer', name }, 'reviewing', { lastReport, pr })
  }
  if (report?.status === 'DONE') return [update(claim, { phase: 'done', lastReport }), retireAll(claim)]
  return [
    stall(claim, lastReport === undefined || lastReport === '' ? 'no final report' : lastReport, 'failed'),
  ]
}

function afterAnswer(claim: Claim, obs: Observation): Action[] {
  const answer = obs.inbox?.find(m => claim.questionId !== undefined && m.inReplyTo === claim.questionId)
  if (answer === undefined || claim.questionId === undefined) return []
  const context: SpawnContext = { kind: 'answer', questionId: claim.questionId, answer }
  return successor(claim, context, { questionId: undefined })
}

/** An approved PR goes to Shepherd for CI and merge; a PR Shepherd already holds is not registered again. */
function afterReviewer(claim: Claim, obs: Observation): Action[] {
  const verdict = obs.report?.verdict
  const lastReport = obs.report?.firstLine
  if (verdict === 'APPROVE' && claim.pr !== undefined)
    return obs.shepherd?.row === undefined
      ? handOff(claim, claim.pr, workerOf(claim), { lastReport })
      : [update(claim, { phase: 'shepherding', lastReport })]
  const why = `verdict ${verdict ?? 'unreadable'}${claim.pr === undefined ? ', no PR' : ''}`
  const round = claim.reviewRound ?? 0
  if (round >= 1) return [stall(claim, `second failed review (${why})`, 'failed')]
  return successor(claim, { kind: 'review', review: obs.report?.text ?? why }, { reviewRound: round + 1 })
}

const ENDED: ReadonlySet<ShepherdRow['phase']> = new Set(['done', 'failed', 'cancelled'])

/** Shepherd merges; the claim finishes once its run has landed the PR, and stalls on a run that ended any other way. */
function afterMerge(claim: Claim, obs: Observation): Action[] {
  if (claim.pr === undefined) return [stall(claim, 'no PR recorded for Shepherd to merge', 'failed')]
  if (obs.shepherd === undefined) return []
  const { row, landed } = obs.shepherd
  if (row === undefined) return handOff(claim, claim.pr, workerOf(claim), {})
  const head = row.headSha === null ? {} : { prHead: row.headSha }
  if (row.phase === 'post-merge' || (row.phase === 'done' && landed === true))
    return [update(claim, { phase: 'done', ...head }), retireAll(claim)]
  if (ENDED.has(row.phase)) {
    const why = row.stalled === null ? '' : `: ${row.stalled.reason}`
    return [
      update(claim, {
        stalledClass: 'failed',
        stallCode: 'shepherd-ended',
        stalledReason: `Shepherd run ${row.runId} ended ${row.phase} without merging${why}`,
        ...head,
      }),
    ]
  }
  return claim.phase === 'awaiting-merge' ? [update(claim, { phase: 'shepherding' })] : []
}

/** A PR Shepherd cannot name stalls here; one it refuses stalls when the register runs. */
function handOff(claim: Claim, pr: string, implementer: string, patch: ClaimPatch): Action[] {
  const target = shepherdTarget(pr)
  if (target === undefined) return [stall(claim, `${pr} is not a GitHub PR Shepherd can take`, 'failed')]
  const registration = { target, task: `${claim.initiative}/${claim.taskId}`, implementer }
  return [
    update(claim, { ...patch, phase: 'shepherding', pr }),
    { kind: 'register', key: keyOf(claim), registration },
  ]
}

/** The worker the claim's next successor takes over from: the latest successor, else the original. */
const workerOf = (claim: Claim): string =>
  (claim.attempt ?? 0) > 0
    ? successorNameFor(claim.taskId, claim.attempt ?? 0, claim.slice, claim.namePrefix)
    : agentNameFor(claim.taskId, claim.slice, claim.namePrefix)

function successor(claim: Claim, context: SpawnContext, patch: ClaimPatch): Action[] {
  if (claim.worktree === undefined)
    return [stall(claim, 'no worktree recorded for a successor to adopt', 'failed')]
  const attempt = (claim.attempt ?? 0) + 1
  const name = successorNameFor(claim.taskId, attempt, claim.slice, claim.namePrefix)
  const request = {
    role: 'successor' as const,
    name,
    predecessor: workerOf(claim),
    worktree: claim.worktree,
    context,
  }
  return spawn(claim, request, 'implementing', { ...patch, attempt })
}

type SpawnRequest = Omit<Extract<Action, { kind: 'spawn' }>, 'kind' | 'key'>

/** The claim moves to `spawning` before the frame goes out, so a crash between the two is reconciled by name. */
function spawn(claim: Claim, request: SpawnRequest, nextPhase: AgentPhase, patch: ClaimPatch): Action[] {
  const spawned = [...(claim.spawned ?? []), request.name]
  const intent = {
    ...patch,
    phase: 'spawning' as const,
    nextPhase,
    agentName: request.name,
    agentId: undefined,
    spawned,
  }
  return [update(claim, intent), { kind: 'spawn', key: keyOf(claim), ...request }]
}

function retireAll(claim: Claim): Action {
  const names = [
    ...new Set(
      [...(claim.spawned ?? [])].reverse().concat(agentNameFor(claim.taskId, claim.slice, claim.namePrefix)),
    ),
  ]
  return { kind: 'retire', key: keyOf(claim), names }
}

/** The ledger after `actions`; a phase change restarts the phase clock. */
export function applyActions(ledger: Ledger, actions: Action[], now: Date): Ledger {
  const at = now.toISOString()
  return actions.reduce<Ledger>((current, action) => {
    if (action.kind === 'add') return action.claims.reduce(addClaim, current)
    if (action.kind !== 'update') return current
    const claims = current.claims.map(c =>
      c.phase !== 'done' && sameClaim(c, action.key) ? patched(c, action.patch, at) : c,
    )
    return { ...current, claims }
  }, ledger)
}

const patched = (claim: Claim, patch: ClaimPatch, at: string): Claim => ({
  ...claim,
  ...patch,
  phaseAt: patch.phase !== undefined && patch.phase !== claim.phase ? at : claim.phaseAt,
})
