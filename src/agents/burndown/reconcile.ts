import {
  agentGone,
  claimKey,
  ENDED,
  landedRun,
  type Action,
  type ClaimKey,
  type Observation,
} from './advance.js'
import type { Claim, Ledger, Phase } from './ledger.js'

/**
 * CC-982: a held claim the world contradicts leaves the ledger by its own (task, slice) key, and says why. Pure:
 * `advance` acts on `taskClosed`, and the tick prints `reconciledLines` once the ledger write applied.
 */

/** Phases with no PR to read: a claim there with no PR recorded has none open. */
const PR_LESS: ReadonlySet<Phase> = new Set(['planning', 'parked'])

/** A fresh PR read that is not open; an unreadable or absent read keeps the claim. */
function noOpenPr(claim: Claim, obs: Observation): boolean {
  const pr = obs.prState
  if (pr === 'unreadable') return false
  if (pr !== undefined) return pr.kind !== 'open'
  return claim.pr === undefined && PR_LESS.has(claim.phase)
}

const noOpenRun = (obs: Observation): boolean => {
  const row = obs.shepherd?.row
  return row === undefined || ENDED.has(row.phase)
}

/**
 * R1-R5, fail closed: the task reads done, the claim is past spawning and not queued (CC-1230 d's), its agent is
 * gone with no respawn pending, and neither GitHub nor Shepherd holds anything open for it.
 */
export function taskClosed(claim: Claim, obs: Observation): boolean {
  if (obs.taskStatus !== 'done') return false
  if (claim.phase === 'queued' || claim.phase === 'spawning' || claim.phase === 'done') return false
  if (claim.respawn !== undefined || !agentGone(claim, obs)) return false
  return noOpenPr(claim, obs) && noOpenRun(obs)
}

const SHEPHERD_PHASES: ReadonlySet<Phase> = new Set(['shepherding', 'awaiting-merge'])

/** A claim Shepherd was meant to land, and did: the seat already hears it as `merged`. */
const ordinaryLanding = (claim: Claim, obs: Observation): boolean =>
  SHEPHERD_PHASES.has(claim.phase) &&
  claim.stalledReason === undefined &&
  landedRun(obs.shepherd) !== undefined

function finishReason(claim: Claim, obs: Observation): string | undefined {
  if (ordinaryLanding(claim, obs)) return undefined
  const pr = obs.prState
  if (pr !== undefined && pr !== 'unreadable' && pr.kind === 'merged') return `${pr.pr} merged`
  const row = landedRun(obs.shepherd)
  if (row !== undefined && row.pr !== null) return `${row.repo}#${row.pr} merged (Shepherd)`
  return taskClosed(claim, obs) ? 'task status done' : undefined
}

function reasonFor(claim: Claim, obs: Observation, actions: Action[]): string | undefined {
  const own = actions.filter(a => 'key' in a && claimKey(a.key) === claimKey(claim))
  const release = own.find(a => a.kind === 'release')
  if (release !== undefined) return `released: ${release.reason ?? release.code ?? 'no reason'}`
  const finishes = own.some(a => a.kind === 'update' && a.patch.phase === 'done')
  return finishes ? finishReason(claim, obs) : undefined
}

/** Why the tick's actions settle each held claim outside the ordinary flow, keyed by `claimKey`. */
export function reconcileReasons(
  held: readonly Claim[],
  actions: Action[],
  observations: ReadonlyMap<string, Observation>,
): Map<string, string> {
  const reasons = new Map<string, string>()
  for (const claim of held) {
    const reason = reasonFor(claim, observations.get(claimKey(claim)) ?? {}, actions)
    if (reason !== undefined) reasons.set(claimKey(claim), reason)
  }
  return reasons
}

export interface Reconciled {
  key: ClaimKey
  reason: string
}

const heldPhase = (ledger: Ledger, key: string): Phase | undefined =>
  ledger.claims.find(c => c.phase !== 'done' && claimKey(c) === key)?.phase

/** Only keys whose claim left `held`, or went back to the queue, in the ledger as written: never the plan. */
export function reconciledLines(
  before: Ledger,
  after: Ledger,
  reasons: ReadonlyMap<string, string>,
): Reconciled[] {
  return before.claims.flatMap((claim): Reconciled[] => {
    const key = claimKey(claim)
    const reason = reasons.get(key)
    if (reason === undefined || claim.phase === 'done' || claim.phase === 'queued') return []
    const now = heldPhase(after, key)
    if (now !== undefined && now !== 'queued') return []
    return [{ key: { taskId: claim.taskId, slice: claim.slice }, reason }]
  })
}

export const reconciledText = ({ key, reason }: Reconciled): string =>
  `reconciled ${claimKey(key)}: ${reason}`
