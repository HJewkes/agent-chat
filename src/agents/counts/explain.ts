import type { Claim } from '../burndown/ledger.js'
import { LIVE } from '../burndown/observe.js'
import type { StaleClass } from '../burndown/stale-claim.js'
import type {
  Count,
  ExplainCode,
  ParkKept,
  PrRow,
  Read,
  Roster,
  RosterRow,
  ShepherdRun,
  Verdict,
  WorktreeRow,
} from './types.js'

/** CC-1282 (K1): the verdict for one item a cache holds beyond live state. Pure: every input is read already. */

export const SPAWN_BOUND_MS = 10 * 60_000
/** Stale classes decision 266 never auto-releases: the seat is told, and the claim is listed by name and age. */
const ESCALATED: ReadonlySet<StaleClass> = new Set(['outside-owns', 'blocked', 'timeout'])

export const AGREE: Verdict = { kind: 'agree' }

export const isRead = <T>(read: Read<T>): read is { value: T } => 'value' in read

export const readFailure = (...reads: Read<unknown>[]): string | undefined =>
  reads.map(r => ('error' in r ? r.error : undefined)).find(e => e !== undefined)

export const unread = (why: string): Verdict => ({ kind: 'unread', why })
const unexplained = (why: string): Verdict => ({ kind: 'unexplained', why })
const explained = (code: ExplainCode, since: string, maxAgeMs?: number): Verdict =>
  maxAgeMs === undefined ? { kind: 'explained', code, since } : { kind: 'explained', code, since, maxAgeMs }

/** An explained verdict past its age bound is unexplained: a disposition that never resolves is drift. */
export function bounded(verdict: Verdict, now: Date): Verdict {
  if (verdict.kind !== 'explained' || verdict.maxAgeMs === undefined) return verdict
  const age = now.getTime() - Date.parse(verdict.since)
  if (age <= verdict.maxAgeMs) return verdict
  return unexplained(
    `${verdict.code} since ${verdict.since} is past its ${Math.round(verdict.maxAgeMs / 60_000)} min bound`,
  )
}

export const isLiveRow = (row: RosterRow | undefined): boolean => row !== undefined && LIVE.has(row.state)

/** The claim's agent row: by identity first, since names are reused across spawns, then a live row of its name. */
function agentRow(claim: Claim, roster: Roster): RosterRow | undefined {
  const byId = roster.rows.find(r => claim.agentId !== undefined && r.agentId === claim.agentId)
  const named = roster.rows.filter(r => claim.agentName !== undefined && r.name === claim.agentName)
  return byId ?? named.find(isLiveRow) ?? named[0]
}

export type AgentState = 'live' | 'gone' | 'unread'

export function claimAgent(claim: Claim, roster: Roster): AgentState {
  if (claim.agentId === undefined && claim.agentName === undefined) return 'gone'
  const row = agentRow(claim, roster)
  if (row === undefined) return roster.partial === undefined ? 'gone' : 'unread'
  return isLiveRow(row) ? 'live' : 'gone'
}

export interface ClaimContext {
  now: Date
  tickMs: number
  roster: Roster
  pr: (pr: string) => Read<PrRow | undefined>
  runs: Read<ShepherdRun[]>
}

export function explainClaim(claim: Claim, ctx: ClaimContext): Verdict {
  const agent = claimAgent(claim, ctx.roster)
  if (agent === 'live') return AGREE
  if (agent === 'unread')
    return unread(`agent ${claim.agentName ?? claim.agentId} has no row on a partial roster`)
  return bounded(disposition(claim, ctx), ctx.now)
}

function disposition(claim: Claim, ctx: ClaimContext): Verdict {
  const review = claim.pr === undefined ? undefined : reviewVerdict(claim.pr, claim.phaseAt, ctx)
  if (review !== undefined) return review
  const stale = claim.stale
  if ((stale !== undefined && ESCALATED.has(stale.class)) || claim.stallCode === 'outside-owns')
    return explained('escalated', stale?.since ?? claim.stalledAt ?? claim.phaseAt)
  if (stale !== undefined) return explained('stale-action-due', stale.since, 2 * ctx.tickMs)
  if (claim.respawn !== undefined) return explained('respawn-pending', claim.phaseAt, 2 * ctx.tickMs)
  if (claim.phase === 'spawning') return explained('spawning', claim.phaseAt, SPAWN_BOUND_MS)
  if (claim.phase === 'parked' && claim.questionId !== undefined)
    return explained('parked-claim', claim.phaseAt)
  if (claim.phase === 'queued') return explained('slices-queued', claim.phaseAt)
  return unexplained(`${claim.phase} claim, agent ${claim.agentName ?? 'none'} not live, no disposition`)
}

/** In review needs both the PR open and a Shepherd run not ended; a PR that is not open is never a hold. */
function reviewVerdict(pr: string, since: string, ctx: ClaimContext): Verdict | undefined {
  const read = ctx.pr(pr)
  if (!isRead(read)) return unread(`PR ${pr}: ${read.error}`)
  if (read.value === undefined || read.value.state !== 'open')
    return unexplained(`PR ${pr} is ${read.value?.state ?? 'not open'}`)
  if (!isRead(ctx.runs)) return unread(`Shepherd runs: ${ctx.runs.error}`)
  return ctx.runs.value.some(r => r.pr === pr && !r.ended) ? explained('in-review', since) : undefined
}

export interface TreeContext {
  now: Date
  sweepMs: number
  roster: Read<Roster>
  heldClaims: Read<Claim[]>
  runs: Read<ShepherdRun[]>
  parkKept: Read<ParkKept[]>
}

/** A tree on disk is a live agent's cwd, kept by a hold, or kept by a park refusal recorded within one sweep. */
export function explainTree(tree: WorktreeRow, ctx: TreeContext): Verdict {
  if (!isRead(ctx.roster)) return unread(`roster: ${ctx.roster.error}`)
  const rows = ctx.roster.value.rows.filter(r => r.cwd === tree.path)
  if (rows.some(isLiveRow)) return AGREE
  if (rows.length === 0 && ctx.roster.value.partial !== undefined)
    return unread('tree has no row on a partial roster')
  if (!isRead(ctx.heldClaims)) return unread(`ledger: ${ctx.heldClaims.error}`)
  const claim = ctx.heldClaims.value.find(c => c.worktree === tree.path)
  if (claim !== undefined) return explained('park-held', claim.phaseAt)
  if (!isRead(ctx.runs)) return unread(`Shepherd runs: ${ctx.runs.error}`)
  if (ctx.runs.value.some(r => r.worktree === tree.path && !r.ended))
    return explained('park-held', ctx.now.toISOString())
  if (!isRead(ctx.parkKept)) return unread(`park-kept rows: ${ctx.parkKept.error}`)
  const kept = ctx.parkKept.value
    .filter(k => k.tree === tree.path)
    .sort((a, b) => b.at.localeCompare(a.at))[0]
  if (kept === undefined) return unexplained('no live agent, no hold and no park-kept reason')
  return bounded(explained('park-refused', kept.at, ctx.sweepMs), ctx.now)
}

const SEVERITY: Record<Verdict['kind'], number> = { agree: 0, explained: 1, unexplained: 2, unread: 3 }

/** The count's verdict is its worst item's: an unread reader outranks everything, so it is never shown as agreeing. */
export function countVerdict(count: Count): Verdict['kind'] {
  if (count.live === undefined) return 'unread'
  return count.items.reduce<Verdict['kind']>(
    (worst, item) => (SEVERITY[item.verdict.kind] > SEVERITY[worst] ? item.verdict.kind : worst),
    'agree',
  )
}
