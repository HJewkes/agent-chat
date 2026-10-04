import { claimKey, type Action, type ClaimKey, type Observation } from './advance.js'
import { AGENT_PHASES, type Claim, type Ledger } from './ledger.js'
import { classify } from './stall.js'
import type { StallCode } from './stall-code.js'

/**
 * The stalled-after-claim finding on a claim (CC-654): opened when the live
 * agent's transcript shows no progress, refreshed while that holds, and closed
 * once it moves, finishes or the claim is stalled for the owner. Pure, apart
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

/** A transcript with no progress is the one verdict this check gives (CC-653). */
const IDLE_CODE: StallCode = 'no-progress'

function describeStall(code: StallCode, reason: Finding['reason'], since: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - Date.parse(since)) / MINUTE_MS)
  return `${code}: ${reason}: no agent event for ${minutes} min since ${since}`
}

function stalledFinding(claim: Claim, reason: Finding['reason'], since: string, now: Date): Finding {
  const at = now.toISOString()
  return {
    kind: 'stalled-after-claim',
    reason,
    code: IDLE_CODE,
    since,
    openedAt: claim.finding?.openedAt ?? at,
    checkedAt: at,
    detail: describeStall(IDLE_CODE, reason, since, now),
  }
}

function actionFor(claim: Claim, obs: Observation, now: Date): Update[] {
  if (obs.activity === undefined) return []
  const { read, spawnedAt } = obs.activity
  const stall = classify(read, claim, { spawnedAt }, now)
  if (stall.state === 'unknown') return []
  if (stall.state === 'working') return claim.finding === undefined ? [] : [setFinding(claim, undefined)]
  const lastAt = typeof read === 'object' ? read.lastAt : undefined
  const since = lastAt ?? new Date(spawnedAt).toISOString()
  return [setFinding(claim, stalledFinding(claim, stall.reason, since, now))]
}

/**
 * Updates that keep each claim's finding true. A claim advance moved, or one
 * the tick stalled for the owner, has its finding closed; an unknown read
 * leaves it as it is.
 */
export function findingActions(
  claims: readonly Claim[],
  observations: ReadonlyMap<string, Observation>,
  moved: ReadonlySet<string>,
  now: Date,
): Update[] {
  return claims.flatMap(claim => {
    if (claim.phase === 'done') return []
    const key = claimKey(claim)
    if (moved.has(key) || claim.stalledReason !== undefined)
      return claim.finding === undefined ? [] : [setFinding(claim, undefined)]
    if (!inLane(claim)) return []
    return actionFor(claim, observations.get(key) ?? {}, now)
  })
}

/** The finding updates go first: a claim advance moves to `done` takes no update after it. */
export function withFindings(
  actions: Action[],
  claims: readonly Claim[],
  observations: ReadonlyMap<string, Observation>,
  now: Date,
): Action[] {
  return [...findingActions(claims, observations, keysOf(actions), now), ...actions]
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
