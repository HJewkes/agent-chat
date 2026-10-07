import { claimKey, type Action, type ClaimKey, type Observation } from './advance.js'
import { AGENT_PHASES, type Claim, type Ledger } from './ledger.js'
import { leaseStep, sameLease, type LeaseStep } from './lease.js'
import { classify, type Stall } from './stall.js'
import { firstCode, type StallCode } from './stall-code.js'

/**
 * The stalled-after-claim finding on a claim (CC-654): opened when the live
 * agent's transcript shows no progress or its lease gives a verdict (CC-659),
 * refreshed while that holds, and closed once it moves, finishes or the claim
 * is stalled for the owner. Pure, apart
 * from `logFindings`, which only reports.
 */

type Finding = NonNullable<Claim['finding']>
type Update = Extract<Action, { kind: 'update' }>

const MINUTE_MS = 60_000

const inLane = (claim: Claim): boolean => (AGENT_PHASES as readonly string[]).includes(claim.phase)

const keysOf = (actions: readonly Action[]): Set<string> =>
  new Set(actions.flatMap(a => (a.kind === 'add' ? [] : [claimKey(a.key)])))

const setFinding = (key: ClaimKey, finding: Finding | undefined): Update => ({
  kind: 'update',
  key,
  patch: { finding },
})

/** A transcript with no progress is the one verdict CC-653's check gives. */
const IDLE_CODE: StallCode = 'no-progress'

const minutesSince = (since: string, now: Date): number =>
  Math.floor((now.getTime() - Date.parse(since)) / MINUTE_MS)

function describeStall(code: StallCode, reason: Finding['reason'], since: string, now: Date): string {
  const what = reason === 'lease' ? 'no commit' : 'no agent event'
  return `${code}: ${reason}: ${what} for ${minutesSince(since, now)} min since ${since}`
}

function stalledFinding(
  claim: Claim,
  { reason, code, since }: Pick<Finding, 'reason' | 'code' | 'since'>,
  now: Date,
): Finding {
  const at = now.toISOString()
  const coded = code ?? IDLE_CODE
  return {
    kind: 'stalled-after-claim',
    reason,
    code: coded,
    since,
    openedAt: claim.finding?.openedAt ?? at,
    checkedAt: at,
    detail: describeStall(coded, reason, since, now),
  }
}

type Idle = Stall & { since: string }

/** CC-653's read of the transcript; undefined when the tick did not read one. */
function idleRead(claim: Claim, obs: Observation, now: Date): Idle | undefined {
  if (obs.activity === undefined) return undefined
  const { read, spawnedAt } = obs.activity
  const stall = classify(read, claim, { spawnedAt }, now)
  const lastAt = typeof read === 'object' ? read.lastAt : undefined
  return { ...stall, since: lastAt ?? new Date(spawnedAt).toISOString() }
}

/** A finding closes only on a read of its own source that shows no stall; an unknown read leaves it as it is. */
function cleared(claim: Claim, idle: Idle | undefined, step: LeaseStep): boolean {
  if (claim.finding?.reason === 'lease') return step.unknown !== true
  return idle?.state === 'working'
}

/** One finding with the first code of the lease's and the transcript's verdicts (CC-659). */
function nextFinding(claim: Claim, obs: Observation, step: LeaseStep, now: Date): Finding | undefined {
  const idle = idleRead(claim, obs, now)
  const idleCode = idle?.state === 'stalled' ? IDLE_CODE : undefined
  const code = firstCode([step.verdict, idleCode].filter(c => c !== undefined))
  if (code === undefined) return cleared(claim, idle, step) ? undefined : claim.finding
  if (code === step.verdict && step.lease !== undefined)
    return stalledFinding(claim, { reason: 'lease', code, since: step.lease.progressAt }, now)
  if (idle?.state !== 'stalled') return claim.finding
  return stalledFinding(claim, { reason: idle.reason, code: IDLE_CODE, since: idle.since }, now)
}

function actionFor(claim: Claim, obs: Observation, parked: Parked, now: Date): Update[] {
  const step = leaseStep(claim, obs, { parked: claim.seat !== undefined && parked(claim.seat), now })
  const finding = nextFinding(claim, obs, step, now)
  const patch: Update['patch'] = {}
  if (finding !== claim.finding) patch.finding = finding
  if (!sameLease(step.lease, claim.lease)) patch.lease = step.lease
  return Object.keys(patch).length === 0 ? [] : [{ kind: 'update', key: claim, patch }]
}

/** Whether a seat's pool gate is closed this tick. */
export type Parked = (seat: string) => boolean

const NEVER_PARKED: Parked = () => false

/**
 * Updates that keep each claim's finding and lease true. A claim advance moved,
 * or one the tick stalled for the owner, has its finding closed; an unknown read
 * leaves it as it is.
 */
export function findingActions(
  claims: readonly Claim[],
  observations: ReadonlyMap<string, Observation>,
  moved: ReadonlySet<string>,
  now: Date,
  parked: Parked = NEVER_PARKED,
): Update[] {
  return claims.flatMap(claim => {
    if (claim.phase === 'done') return []
    const key = claimKey(claim)
    if (moved.has(key) || claim.stalledReason !== undefined || claim.respawn !== undefined)
      return claim.finding === undefined ? [] : [setFinding(claim, undefined)]
    if (!inLane(claim)) return []
    return actionFor(claim, observations.get(key) ?? {}, parked, now)
  })
}

/** The finding updates go first: a claim advance moves to `done` takes no update after it. */
export function withFindings(
  actions: Action[],
  claims: readonly Claim[],
  observations: ReadonlyMap<string, Observation>,
  now: Date,
  parked: Parked = NEVER_PARKED,
): Action[] {
  return [...findingActions(claims, observations, keysOf(actions), now, parked), ...actions]
}

/** One log row when a finding opens and one when it closes; a refresh logs nothing. */
export function logFindings(
  before: Ledger,
  after: Ledger,
  log: (event: string, detail: Record<string, unknown>) => void,
): void {
  before.claims.forEach((was, i) => {
    const claim = after.claims[i]
    if (claim === undefined) return
    if (was.finding === undefined && claim.finding !== undefined) report(log, claim, 'opened', claim.finding)
    else if (was.finding !== undefined && claim.finding === undefined)
      report(log, claim, 'closed', was.finding)
  })
}

function report(
  log: (event: string, detail: Record<string, unknown>) => void,
  claim: Claim,
  state: 'opened' | 'closed',
  { reason, code, since }: Finding,
): void {
  log('burndown_finding', { task: claim.taskId, slice: claim.slice, reason, code, state, since })
}
