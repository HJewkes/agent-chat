import type { AgentLifecycle, DeliveredMessage } from '../../protocol.js'
import type { ExceptionClass } from './exception.js'
import type { ExitedWork } from './exited-adopt.js'
import {
  addClaim,
  isStalled,
  sameClaim,
  type AgentPhase,
  type BrakeState,
  type Claim,
  type LadderRecord,
  type Ledger,
} from './ledger.js'
import type { Adjudication } from './owns-adjudicate.js'
import type { ClaimPr } from './pr-state.js'
import { agentNameFor, reviewerNameFor, successorNameFor } from './plan.js'
import type { Progress } from './progress.js'
import type { PlannedSlice, Report } from './report.js'
import { sliceClaims } from './seed-slices.js'
import { shepherdTarget, type Registration, type ShepherdRow } from './shepherd.js'
import { capVerdict, type ClaimSpend } from './spend-cap.js'
import { classifyStale } from './stale-claim.js'
import type { ActivityRead } from './stall.js'
import { LADDER_CODES, parkUpdate, type StallCode } from './stall-code.js'
import { BRANCH_PREFIX } from '../isolation/worktree.js'

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
  /** CC-939: whether a finished briefer's task now carries `brief:proposed`, or (CC-1076) its approval. */
  proposed?: boolean
  /** A finished planner's slices, parsed from its plan file. */
  slices?: PlannedSlice[]
  /** CC-631: why a finished planner's slices were refused, one line per slice and rule. */
  sliceProblems?: string[]
  /** A live lane agent's transcript read for the stall check, with the row's spawn time (CC-654). */
  activity?: { read: ActivityRead; spawnedAt: number }
  /** A live implementer's worktree HEAD and uncommitted hash (CC-659); read, not yet acted on. */
  progress?: Progress | 'unreadable'
  diff?: { reviewable: boolean; reason: string }
  /**
   * CC-669: the files a finished implementer's branch touches outside its slice's `owns`; absent when the slice owns
   * nothing. CC-1150 f: `adjudicated` says whether they may join `owns`; absent, they stall as before. CC-1023: a
   * silent exit's adopted PR adds its own files, and an unreadable PR read reads as unreadable.
   */
  owned?: { outside: string[]; adjudicated?: Adjudication } | 'unreadable'
  /** CC-1232: the plan's owns for a stalled outside-owns slice, which `owned` was read against; a clear keeps them. */
  planOwns?: string[]
  /** Shepherd's row for the claim's PR, absent from the row when Shepherd has none; `landed` is read for a finished run. */
  shepherd?: { row?: ShepherdRow; landed?: boolean }
  /** CC-723: the claim's transcript spend over every agent it spawned, against its seat's `per_claim_usd`; read, not yet acted on. */
  spend?: { claim: ClaimSpend; cap: number }
  /** CC-673: an implementer that exited with no status line: its branch's open PR and commits ahead. */
  exitedWork?: ExitedWork | 'unreadable'
  /** CC-1054: what GitHub says about an implementing or stalled claim's PR, by its record or its agents' branches; only a merge acts. */
  prState?: ClaimPr | 'unreadable'
}

export type SpawnContext =
  | { kind: 'answer'; questionId: string; answer: InboxMessage }
  | { kind: 'review'; review: string }
  /** A ladder respawn (CC-660): the stall's code and what the predecessor left in the worktree. */
  | { kind: 'stall'; code: StallCode; diffSummary: string }
  /** CC-673: the predecessor exited with no status line and left commits ahead; at most once per claim. */
  | { kind: 'resume'; ahead: number }

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
  | RetireAction
  | { kind: 'add'; claims: Claim[] }
  /** Hands the claim's PR to Shepherd, after the update that moves it to `shepherding`. */
  | { kind: 'register'; key: ClaimKey; registration: Registration }
  /** Writes the claim's triage ladder record (CC-660); absent prunes it (CC-829). */
  | { kind: 'ladder'; key: ClaimKey; record?: LadderRecord }
  /** Writes the ladder's brake (CC-699); absent clears it. */
  | { kind: 'brake'; brake?: BrakeState }
  /**
   * Ladder rung 2 (CC-698): the claim lets go of its worktree and branch, which stay. A slice goes back to
   * `queued` for the planner's work to survive; a whole task is dropped. Never clears `ledger.liveness`.
   */
  | {
      kind: 'release'
      key: ClaimKey
      branch?: string
      requeue: boolean
      /** Absent for a release that is no stall: CC-1158 d's `stack-broken` carries `reason` instead. */
      code?: StallCode
      reason?: string
      /** The agents that may still run, newest first; a retired one is no longer the broker's to retire. */
      names: string[]
    }

/** Retire in the order given; `held` records a refusal on the held claim rather than a done one (CC-660). */
export type RetireAction = {
  kind: 'retire'
  key: ClaimKey
  names: string[]
  held?: true
  /** Applied only once every name retired, so a refused retire leaves the claim as it was (CC-698). */
  then?: Action[]
}

export const claimKey = (c: ClaimKey): string => `${c.taskId}#${c.slice ?? ''}`

export function advance(
  claims: Claim[],
  observations: ReadonlyMap<string, Observation>,
  now: Date,
  mayRun: (name: string) => boolean = () => true,
): Action[] {
  const actions = claims.flatMap(claim => {
    const obs = observations.get(claimKey(claim)) ?? {}
    return withStale(claim, obs, now, advanceClaim(claim, obs, now))
  })
  return withStackReleases(claims, observations, actions, mayRun)
}

/** CC-1158 d: a stacked child whose parent broke is released, and nothing else the tick planned for it stands. */
function withStackReleases(
  claims: Claim[],
  observations: ReadonlyMap<string, Observation>,
  actions: Action[],
  mayRun: (name: string) => boolean,
): Action[] {
  const releases = brokenStacks(claims, mayRun, observations)
  if (releases.length === 0) return actions
  const broken = new Set(releases.map(r => claimKey(r.key)))
  const kept = actions.filter(a => !('key' in a) || !broken.has(claimKey(a.key)))
  return [...kept, ...releases]
}

/**
 * CC-1150 b: a claim left stalled with its agent gone and no respawn pending is classified on the first tick that
 * sees it, with no age gate, so the seat hears what it waits on. It never releases or finishes the claim.
 */
function withStale(claim: Claim, obs: Observation, now: Date, actions: Action[]): Action[] {
  if (claim.respawn !== undefined || !agentGone(claim, obs)) return actions
  if (actions.some(a => a.kind !== 'update')) return actions
  const at = now.toISOString()
  const after = actions.reduce<Claim>((c, a) => (a.kind === 'update' ? patched(c, a.patch, at) : c), claim)
  if (after.phase === 'done' || after.stalledReason === undefined || after.stale !== undefined) return actions
  if (ladderFirst(claim, after)) return actions
  const { class: cls, proposed, until } = classifyStale(after, obs)
  const stale = { class: cls, proposed, since: at, ...(until === undefined ? {} : { until }) }
  return [...actions, update(claim, { stale })]
}

/** A stall this tick opened with a ladder code is the ladder's to respawn or release first; it is classified next tick. */
const ladderFirst = (claim: Claim, after: Claim): boolean =>
  claim.stalledReason === undefined && after.stallCode !== undefined && LADDER_CODES.includes(after.stallCode)

type Step = (claim: Claim, obs: Observation, now: Date) => Action[]

const STEPS: Partial<Record<Claim['phase'], Step>> = {
  spawning: (claim, obs) => (obs.agent === undefined ? [] : [landed(claim, obs.agent.id)]),
  planning: (claim, obs, now) =>
    !finished(obs) ? [] : claim.briefer === true ? afterBriefer(claim, obs) : afterPlanner(claim, obs, now),
  implementing: (claim, obs) => (finished(obs) ? afterWorker(claim, obs) : linkPr(claim, obs)),
  parked: afterAnswer,
  reviewing: (claim, obs) => (finished(obs) ? afterReviewer(claim, obs) : []),
  'awaiting-merge': afterMerge,
  shepherding: afterMerge,
}

function advanceClaim(claim: Claim, obs: Observation, now: Date): Action[] {
  if (claim.phase === 'done') return []
  const merged = MERGES.has(claim.phase) ? landedRun(obs.shepherd) : undefined
  if (merged !== undefined) return mergedPr(claim, prRef(merged), merged.headSha)
  const settled = settledOnGitHub(claim, obs)
  if (settled !== undefined) return settled
  if (claim.stallCode === 'outside-owns') return unfenced(claim, obs, now)
  const shepherds = exitedToShepherd(claim, obs)
  if (shepherds !== undefined) return shepherds
  const healed = reregistered(claim, obs, now)
  if (healed !== undefined) return healed
  if (claim.stalledReason !== undefined) return relink(claim, obs) ?? linkPr(claim, obs)
  if (obs.spend !== undefined && capVerdict(obs.spend.claim, obs.spend.cap) === 'over')
    return overBudget(claim, obs.spend)
  if (claim.respawn !== undefined) return []
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

const UNSTALLED: ClaimPatch = { stalledReason: undefined, stalledClass: undefined, stallCode: undefined }

/**
 * CC-669: a fresh read with nothing outside owns clears the stall, and the claim moves on this tick; a re-read, not
 * a retry. CC-1150 f: so does an amend. An escalation rewrites the stall only when its cause changed.
 */
function unfenced(claim: Claim, obs: Observation, now: Date): Action[] {
  if (obs.owned === undefined || obs.owned === 'unreadable') return []
  const cleared: ClaimPatch = obs.planOwns === undefined ? UNSTALLED : { ...UNSTALLED, owns: obs.planOwns }
  const moveOn: Resume = (c, o) => [update(c, cleared), ...advanceClaim({ ...c, ...cleared }, o, now)]
  const held = fenced(claim, obs, moveOn)
  if (held === undefined) return moveOn(claim, obs) ?? []
  const [restall] = held
  const same =
    held.length === 1 && restall?.kind === 'update' && restall.patch.stalledReason === claim.stalledReason
  return same ? [] : held
}

/** Parks in place of the step's actions, so no reviewer or successor spawns; the branch and worktree stay. */
const overBudget = (claim: Claim, { claim: spend, cap }: NonNullable<Observation['spend']>): Action[] => [
  parkUpdate(keyOf(claim), 'budget', `spent $${spend.usd.toFixed(2)} of $${cap} (${spend.agents} agents)`),
  retireAll(claim),
]

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
  const slices = sliceClaims(claim, obs.slices, now)
  return [update(claim, { phase: 'done' }), { kind: 'add', claims: slices }, retireAll(claim)]
}

/** CC-939: a briefer is done only once the task carries `brief:proposed`; anything else stalls, as a planner with no slices does. */
function afterBriefer(claim: Claim, obs: Observation): Action[] {
  const status = obs.report?.status
  if (status === 'BLOCKED' || status === 'NEEDS_CONTEXT')
    return [stall(claim, obs.report?.firstLine ?? status, 'failed')]
  if (obs.proposed !== true)
    return [stall(claim, 'briefer exited without tagging brief:proposed', 'failed', 'planner-refused')]
  return [update(claim, { phase: 'done' }), retireAll(claim)]
}

const sliceStallReason = (problems: string[] | undefined): string =>
  problems === undefined || problems.length === 0
    ? 'planner left no machine-readable slices'
    : problems.join('\n')

function afterWorker(claim: Claim, obs: Observation): Action[] {
  const report = obs.report
  const lastReport = report?.firstLine
  if (report?.parked !== undefined)
    return [update(claim, { phase: 'parked', questionId: report.parked, lastReport })]
  if (report?.status === 'BLOCKED' || report?.status === 'NEEDS_CONTEXT')
    return [stall(claim, report.firstLine, 'failed')]
  const pr = report?.pr ?? claim.pr
  const handsOff = handsOffPr(report) && pr !== undefined
  const held = handsOff || obs.diff?.reviewable === true ? fenced(claim, obs, afterWorker) : undefined
  if (held !== undefined) return held
  if (handsOff)
    return handOff(claim, pr, claim.agentName ?? workerOf(claim), { lastReport }, obs.shepherd?.row)
  const silent = report === undefined || report.status === 'unknown'
  const adopted = silent ? adoptExited(claim, obs, lastReport) : undefined
  if (adopted !== undefined) return adopted
  if (obs.diff?.reviewable === true) {
    const name = reviewerNameFor(claim.taskId, claim.reviewRound ?? 0, claim.slice, claim.namePrefix)
    return spawn(claim, { role: 'reviewer', name }, 'reviewing', { lastReport, pr })
  }
  if (report?.status === 'DONE') return [update(claim, { phase: 'done', lastReport }), retireAll(claim)]
  return [
    stall(claim, lastReport === undefined || lastReport === '' ? 'no final report' : lastReport, 'failed'),
  ]
}

/** CC-1074: a worker that finished DONE or DONE_WITH_CONCERNS and names a PR goes to Shepherd rather than a reviewer. */
const handsOffPr = (report: Report | undefined): boolean =>
  report?.status === 'DONE' || report?.status === 'DONE_WITH_CONCERNS'

/**
 * CC-1074: a stall `afterWorker` left on a finished worker whose PR is known, from its report or a Shepherd run
 * it registered itself, clears and goes to Shepherd. A coded stall is a deliberate hold and a BLOCKED report a
 * question, so both stay; undefined falls back to `linkPr`.
 */
function relink(claim: Claim, obs: Observation): Action[] | undefined {
  const { report } = obs
  if (claim.phase !== 'implementing' || claim.stallCode !== undefined || !finished(obs)) return undefined
  if (report?.status === 'BLOCKED' || report?.status === 'NEEDS_CONTEXT') return undefined
  const row = obs.shepherd?.row
  const run = row !== undefined && !ENDED.has(row.phase) ? row : undefined
  const reported = handsOffPr(report) ? (report?.pr ?? claim.pr) : undefined
  const pr = reported ?? (run === undefined ? undefined : (claim.pr ?? prRef(run)))
  if (pr === undefined) return undefined
  const cleared: ClaimPatch = {
    stalledReason: undefined,
    stalledClass: undefined,
    ...(report === undefined ? {} : { lastReport: report.firstLine }),
  }
  return fenced(claim, obs, relink) ?? handOff(claim, pr, claim.agentName ?? workerOf(claim), cleared, run)
}

/**
 * CC-1098: an implementer whose agent exited, or left a complete roster, while Shepherd holds an open run for its
 * PR is Shepherd's, so its claim stops counting as an implementer. A question, a deliberate hold or a pending
 * respawn stays where it is; undefined falls through to the phase's own step.
 */
function exitedToShepherd(claim: Claim, obs: Observation): Action[] | undefined {
  if (claim.phase !== 'implementing' || claim.respawn !== undefined || !agentGone(claim, obs))
    return undefined
  if (claim.stallCode !== undefined && !LADDER_CODES.includes(claim.stallCode)) return undefined
  const { report, shepherd } = obs
  if (report?.parked !== undefined || report?.status === 'BLOCKED' || report?.status === 'NEEDS_CONTEXT')
    return undefined
  const run = shepherd?.row !== undefined && !ENDED.has(shepherd.row.phase) ? shepherd.row : undefined
  const reported = handsOffPr(report) ? report?.pr : undefined
  const pr = run === undefined ? undefined : (reported ?? claim.pr ?? prRef(run))
  if (pr === undefined) return undefined
  const cleared: ClaimPatch = {
    stalledReason: undefined,
    stalledClass: undefined,
    stallCode: undefined,
    ...(report === undefined ? {} : { lastReport: report.firstLine }),
  }
  return (
    fenced(claim, obs, exitedToShepherd) ??
    handOff(claim, pr, claim.agentName ?? workerOf(claim), cleared, run)
  )
}

/** An agent with no roster row was retired and pruned; `observe` reports a missing row on a partial roster as unread. */
const agentGone = (claim: Claim, obs: Observation): boolean =>
  finished(obs) || (obs.agent === undefined && claim.agentName !== undefined)

/** The step a fence hands back to once an amend leaves nothing outside owns. */
type Resume = (claim: Claim, obs: Observation) => Action[] | undefined

/**
 * CC-669: a branch outside its slice's owns stalls once with no register and no reviewer; an unreadable one waits.
 * CC-1150 f: an amend adds the files to `owns` and resumes the step this tick; an escalation names its cause.
 */
function fenced(claim: Claim, obs: Observation, resume: Resume): Action[] | undefined {
  const { owned } = obs
  if (owned === undefined) return undefined
  if (owned === 'unreadable') return []
  const [first, ...rest] = owned.outside
  if (first === undefined) return undefined
  const verdict = owned.adjudicated
  if (verdict?.kind === 'amend') return amended(claim, obs, verdict.files, resume)
  if (verdict?.kind === 'escalate' && verdict.protectedPath !== undefined)
    return [protectedPark(claim, verdict.protectedPath)]
  const more = rest.length === 0 ? '' : ` (+${rest.length} more)`
  const cause = verdict === undefined ? '' : `; not amended: ${verdict.reason}`
  return [
    parkUpdate(keyOf(claim), 'outside-owns', `PR touches ${first}${more} outside its slice owns${cause}`),
  ]
}

/**
 * CC-1235: a protected file is never amended in, so the park names it and the plan line to widen, and nothing else:
 * the same text on every tick, whatever else the PR touches, keeps the seat's notice and the stall line single.
 */
const protectedPark = (claim: Claim, file: string): Action =>
  parkUpdate(
    keyOf(claim),
    'outside-owns',
    `PR touches ${file} outside its slice owns; not amended: ${file} is a protected path; widen the owns line of slice ${claim.slice ?? '?'} in the plan to cover ${file}`,
  )

function amended(claim: Claim, obs: Observation, files: string[], resume: Resume): Action[] {
  const patch = {
    owns: [...(claim.owns ?? []), ...files],
    ownsAmended: [...(claim.ownsAmended ?? []), ...files],
  }
  return [update(claim, patch), ...(resume({ ...claim, ...patch }, { ...obs, owned: { outside: [] } }) ?? [])]
}

/**
 * CC-673: adopt what a silent exit left. An open PR goes to Shepherd; commits ahead get one
 * resume successor per claim. An unreadable read waits a tick, under the phase timeout, rather
 * than move on a guess. Nothing here releases the claim; undefined falls through to review or a stall.
 * CC-1023: the PR is fenced by its owns first, read from the PR's own files, since the worktree may hold none of them.
 */
function adoptExited(claim: Claim, obs: Observation, lastReport: string | undefined): Action[] | undefined {
  const work = obs.exitedWork
  if (work === undefined) return undefined
  if (work === 'unreadable') return []
  if (work.openPr !== null)
    return (
      fenced(claim, obs, afterWorker) ??
      handOff(claim, work.openPr, claim.agentName ?? workerOf(claim), { lastReport })
    )
  if (work.ahead > 0 && claim.resumed !== true)
    return successor(claim, { kind: 'resume', ahead: work.ahead }, { resumed: true, lastReport })
  return undefined
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

/** CC-978: phases a merged PR finishes, whatever the claim's agent or a stall says; a queued one is a slice linked to a hand-dispatched PR. */
const MERGES: ReadonlySet<Claim['phase']> = new Set([
  'queued',
  'implementing',
  'reviewing',
  'awaiting-merge',
  'shepherding',
])

function landedRun(run: Observation['shepherd']): ShepherdRow | undefined {
  const row = run?.row
  if (row === undefined) return undefined
  const merged =
    row.phase === 'post-merge' ||
    row.outcome?.kind === 'merged' ||
    (row.phase === 'done' && run?.landed === true)
  return merged ? row : undefined
}

const prRef = (row: ShepherdRow): string | undefined =>
  row.pr === null ? undefined : `${row.repo}#${row.pr}`

/**
 * CC-1054: a PR GitHub reports merged finishes the claim, whatever its stall says. An open PR is Shepherd's,
 * and a claim with no PR is left to the ladder and the owner, which know whether it may be released.
 */
function settledOnGitHub(claim: Claim, obs: Observation): Action[] | undefined {
  const pr = obs.prState
  return pr !== undefined && pr !== 'unreadable' && pr.kind === 'merged'
    ? mergedPr(claim, pr.pr, pr.head)
    : undefined
}

/** A queued claim ran no agent, so it has none to retire. */
function mergedPr(claim: Claim, found: string | undefined, head: string | null): Action[] {
  const pr = claim.pr ?? found
  const finish = update(claim, {
    phase: 'done',
    ...(pr === undefined ? {} : { pr }),
    ...(head === null ? {} : { prHead: head }),
    stalledReason: undefined,
    stalledClass: undefined,
    stallCode: undefined,
  })
  return claim.phase === 'queued' ? [finish] : [finish, retireAll(claim)]
}

/** CC-978: an implementer's PR Shepherd watches is recorded on its claim, so the claim counts as waiting on it. */
function linkPr(claim: Claim, obs: Observation): Action[] {
  const row = obs.shepherd?.row
  if (claim.phase !== 'implementing' || claim.pr !== undefined || row === undefined || ENDED.has(row.phase))
    return []
  const pr = prRef(row)
  return pr === undefined ? [] : [update(claim, { pr })]
}

/** Shepherd merges; `advanceClaim` finishes the claim once its run has landed the PR, and this stalls a run that ended any other way. */
function afterMerge(claim: Claim, obs: Observation): Action[] {
  if (claim.pr === undefined) return [stall(claim, 'no PR recorded for Shepherd to merge', 'failed')]
  if (obs.shepherd === undefined) return []
  const { row } = obs.shepherd
  if (row === undefined) return handOff(claim, claim.pr, workerOf(claim), {})
  const head = row.headSha === null ? {} : { prHead: row.headSha }
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

const TRANSIENT = /ci-timeout|gh-api-5xx|rate-limit|connection/i
const REREGISTER_CAP = 2
const REREGISTER_GAP_MS = 30 * 60_000

/** CC-1229: whether the claim may take one more run: under the cap, 30 minutes on, and the head moved on. */
function mayReregister(claim: Claim, head: string | null, now: Date): boolean {
  const last = claim.reregistered
  if (last === undefined) return true
  const gapped = now.getTime() - Date.parse(last.at) >= REREGISTER_GAP_MS
  return last.n < REREGISTER_CAP && gapped && (head === null || head !== last.head)
}

/**
 * CC-1229: a run that ended failed on a transient class (CI timeout, GitHub 5xx, rate limit, connection) while
 * GitHub reads the PR open goes back to Shepherd, with the claim's own task and implementer. Anything unreadable,
 * unknown, closed or merged, or past the cap, falls through to the park; undefined leaves the claim to its step.
 */
function reregistered(claim: Claim, obs: Observation, now: Date): Action[] | undefined {
  const row = obs.shepherd?.row
  if (claim.stallCode !== undefined && claim.stallCode !== 'shepherd-ended') return undefined
  if (claim.pr === undefined || !(claim.phase === 'shepherding' || claim.phase === 'awaiting-merge'))
    return undefined
  if (row === undefined || row.phase !== 'failed' || !TRANSIENT.test(row.stalled?.reason ?? ''))
    return undefined
  if (obs.prState === undefined || obs.prState === 'unreadable' || obs.prState.kind !== 'open')
    return undefined
  if (!mayReregister(claim, row.headSha, now)) return undefined
  const seen = { n: (claim.reregistered?.n ?? 0) + 1, at: now.toISOString() }
  const reregistered = row.headSha === null ? seen : { ...seen, head: row.headSha }
  return handOff(claim, claim.pr, workerOf(claim), { ...UNSTALLED, reregistered })
}

/**
 * A PR Shepherd cannot name stalls here; one it refuses stalls when the register runs. A run Shepherd
 * already holds open, such as one the agent registered itself, is not registered again (CC-1074).
 */
function handOff(
  claim: Claim,
  pr: string,
  implementer: string,
  patch: ClaimPatch,
  held?: ShepherdRow,
): Action[] {
  const target = shepherdTarget(pr)
  if (target === undefined) return [stall(claim, `${pr} is not a GitHub PR Shepherd can take`, 'failed')]
  const moved = update(claim, { ...patch, phase: 'shepherding', pr })
  if (held !== undefined && !ENDED.has(held.phase)) return [moved]
  const registration = { target, task: `${claim.initiative}/${claim.taskId}`, implementer }
  return [moved, { kind: 'register', key: keyOf(claim), registration }]
}

/** The worker the claim's next successor takes over from: the latest successor, else the original. */
const workerOf = (claim: Claim): string =>
  (claim.attempt ?? 0) > 0
    ? successorNameFor(claim.taskId, claim.attempt ?? 0, claim.slice, claim.namePrefix)
    : agentNameFor(claim.taskId, claim.slice, claim.namePrefix)

export function successor(claim: Claim, context: SpawnContext, patch: ClaimPatch): Action[] {
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

export function retireAll(claim: Claim): RetireAction {
  const names = [
    ...new Set(
      [...(claim.spawned ?? [])].reverse().concat(agentNameFor(claim.taskId, claim.slice, claim.namePrefix)),
    ),
  ]
  return { kind: 'retire', key: keyOf(claim), names }
}

/** The ledger after `actions`; a phase change restarts the phase clock, and so does a new agent, such as a successor spawned from `spawning` (CC-660). */
export function applyActions(ledger: Ledger, actions: Action[], now: Date): Ledger {
  const at = now.toISOString()
  return actions.reduce<Ledger>((current, action) => {
    if (action.kind === 'add') return action.claims.reduce(addClaim, current)
    if (action.kind === 'ladder') return withLadder(current, claimKey(action.key), action.record)
    if (action.kind === 'release') return released(current, action, at)
    if (action.kind === 'brake') {
      const { brake: _cleared, ...rest } = current
      return action.brake === undefined ? rest : { ...rest, brake: action.brake }
    }
    if (action.kind !== 'update') return current
    const claims = current.claims.map(c =>
      c.phase !== 'done' && sameClaim(c, action.key) ? patched(c, action.patch, at) : c,
    )
    return { ...current, claims }
  }, ledger)
}

function withLadder(ledger: Ledger, key: string, record: LadderRecord | undefined): Ledger {
  if (record !== undefined) return { ...ledger, ladder: { ...ledger.ladder, [key]: record } }
  const { ladder: _all, ...rest } = ledger
  const { [key]: _pruned, ...kept } = ledger.ladder ?? {}
  return Object.keys(kept).length === 0 ? rest : { ...rest, ladder: kept }
}

/** What a requeued slice keeps: the planner's slice and who dispatched it, none of the last attempt. */
function requeued(claim: Claim, at: string): Claim {
  const {
    taskId,
    initiative,
    slice,
    dependsOn,
    owns,
    repo,
    contracts,
    overlapsAccepted,
    seat,
    namePrefix,
    spawnedAt,
  } = claim
  return {
    taskId,
    initiative,
    spawnedAt,
    phase: 'queued',
    phaseAt: at,
    ...(slice === undefined ? {} : { slice }),
    ...(dependsOn === undefined ? {} : { dependsOn }),
    ...(owns === undefined ? {} : { owns }),
    ...(repo === undefined ? {} : { repo }),
    ...(contracts === undefined ? {} : { contracts }),
    ...(overlapsAccepted === undefined ? {} : { overlapsAccepted }),
    ...(seat === undefined ? {} : { seat }),
    ...(namePrefix === undefined ? {} : { namePrefix }),
  }
}

/** Counts the release on the key's ladder record and the task's release record, so the backoff applies. */
function released(ledger: Ledger, action: Extract<Action, { kind: 'release' }>, at: string): Ledger {
  const key = claimKey(action.key)
  const held = (c: Claim): boolean => c.phase !== 'done' && sameClaim(c, action.key)
  const claim = ledger.claims.find(held)
  const { code: _code, reason: _reason, ...record } = ledger.ladder?.[key] ?? ({} as Partial<LadderRecord>)
  const claims = action.requeue
    ? ledger.claims.map(c => (held(c) ? requeued(c, at) : c))
    : ledger.claims.filter(c => !held(c))
  return {
    ...ledger,
    claims,
    releases: {
      ...ledger.releases,
      [action.key.taskId]: { n: (ledger.releases?.[action.key.taskId]?.n ?? 0) + 1, at },
    },
    ladder: {
      ...ledger.ladder,
      [key]: {
        respawns: record.respawns ?? 0,
        ...record,
        releases: (record.releases ?? 0) + 1,
        lastAt: at,
        ...(action.code === undefined ? {} : { code: action.code }),
        ...(action.reason === undefined ? {} : { reason: action.reason }),
        ...(action.branch === undefined ? {} : { branch: action.branch }),
        ...(claim?.seat === undefined ? {} : { seat: claim.seat }),
      },
    },
  }
}

const restarts = (claim: Claim, patch: ClaimPatch): boolean =>
  (patch.phase !== undefined && patch.phase !== claim.phase) ||
  (patch.agentName !== undefined && patch.agentName !== claim.agentName)

/** CC-1150 b: a new stall stamps `stalledAt` once; clearing the stall, or a new phase or agent, drops it and `stale`. */
function patched(claim: Claim, patch: ClaimPatch, at: string): Claim {
  const restart = restarts(claim, patch)
  const { stalledAt, stale, ...next } = { ...claim, ...patch, phaseAt: restart ? at : claim.phaseAt }
  if (next.stalledReason === undefined) return next
  const since = claim.stalledReason === undefined ? at : stalledAt
  return {
    ...next,
    ...(since === undefined ? {} : { stalledAt: since }),
    ...(stale === undefined || restart ? {} : { stale }),
  }
}

type Release = Extract<Action, { kind: 'release' }>

/** How a parent broke: its claim went back to the queue, or GitHub reads its PR closed unmerged. */
function parentBroke(
  parent: Claim | undefined,
  obs: Observation | undefined,
): 'released' | 'closed' | undefined {
  if (parent?.phase === 'queued') return 'released'
  return obs?.prState !== undefined && obs.prState !== 'unreadable' && obs.prState.kind === 'closed'
    ? 'closed'
    : undefined
}

const prNumber = (pr: string): string => `#${/(\d+)$/.exec(pr)?.[1] ?? pr}`

/**
 * CC-1158 d: every held claim stacked on a parent that was released or closed unmerged goes back to the queue with
 * its branch kept, so it re-dispatches from the default branch. A merged parent is `done`, so it is not held and
 * breaks nothing; an open one breaks nothing either.
 */
export function brokenStacks(
  claims: readonly Claim[],
  mayRun: (name: string) => boolean,
  observations: ReadonlyMap<string, Observation>,
): Release[] {
  return claims.flatMap((child): Release[] => {
    const on = child.stackedOn
    if (on === undefined) return []
    const parent = claims.find(c => c.taskId === on.taskId && c.slice === on.slice)
    const how = parentBroke(parent, parent === undefined ? undefined : observations.get(claimKey(parent)))
    if (how === undefined) return []
    return [
      {
        kind: 'release',
        key: { taskId: child.taskId, slice: child.slice },
        requeue: true,
        reason: `stack-broken: parent ${on.taskId} ${on.slice} ${prNumber(on.pr)} ${how}`,
        names: retireAll(child).names.filter(mayRun),
        ...(child.agentName === undefined ? {} : { branch: `${BRANCH_PREFIX}${child.agentName}` }),
      },
    ]
  })
}
