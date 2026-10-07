import { claimKey, retireAll, successor, type Action, type ClaimKey } from './advance.js'
import type { Claim, LadderRecord, Ledger } from './ledger.js'
import { LADDER_CODES, parkUpdate, type StallCode } from './stall-code.js'

/**
 * The triage ladder (CC-660): a claim stopped with a ladder code goes up one
 * rung per occurrence. Rung 3 stalls it for the owner, whose `stalled` seat
 * event is the one notice. Rung 2 (release) is CC-698; until it lands a second
 * occurrence goes to rung 3. Pure, apart from the injected readers.
 *
 * Rung 1 spans ticks. The first marks the claim (`respawn`), which `advance`
 * then leaves alone, and retires its agents. A later tick spawns one successor,
 * whose brief carries a diff summary, only once the roster shows every agent
 * retired, so two never share the worktree; a refused retire is retried first.
 * A refused spawn is undone to the marked claim, so the next tick retries it;
 * liveness (CC-671) budgets those retries, so the ladder keeps no failure count.
 * An occurrence is the claim's `phaseAt`, and a respawn counts once the
 * successor's spawn has moved the claim to a new one.
 */

export interface LadderDeps {
  /** `ladder.enabled`; off, the actions pass through and each new occurrence gets one note. */
  enabled: boolean
  /** What a worktree holds; read only for a claim the ladder respawns. */
  diffSummary: (worktree: string) => string
  /** Whether a named agent may still be running. */
  live: (name: string) => boolean
  now: Date
}

export interface Laddered {
  actions: Action[]
  notes: string[]
}

type Update = Extract<Action, { kind: 'update' }>
type Rung = 'respawn' | 'stall-owner'

interface Trigger {
  claim: Claim
  code: StallCode
  /** The claim's stall or finding opened this tick, rather than refreshed. */
  fresh: boolean
}

/** Lease verdicts the ladder acts on; `dirty-uncommitted` waits for its checkpoint request (CC-659 slice D). */
const LEASE_LADDER_CODES: readonly StallCode[] = ['lease-expired', 'no-progress']

/** A terminal stall with a ladder code, or a lease finding (never CC-653's 5-min idle read). */
function triggerOf(action: Update, claims: ReadonlyMap<string, Claim>): Trigger | undefined {
  const claim = claims.get(claimKey(action.key))
  if (claim === undefined) return undefined
  const { stallCode, finding } = action.patch
  if (stallCode !== undefined && LADDER_CODES.includes(stallCode))
    return { claim, code: stallCode, fresh: claim.stalledReason === undefined }
  if (finding?.reason !== 'lease' || finding.code === undefined) return undefined
  if (!LEASE_LADDER_CODES.includes(finding.code)) return undefined
  const fresh = claim.finding?.reason !== 'lease' || claim.finding.code !== finding.code
  return { claim, code: finding.code, fresh }
}

const keyOf = (claim: Claim): ClaimKey => ({ taskId: claim.taskId, slice: claim.slice })

/** Rung 1 ran for an earlier occurrence: counted, or started on one the claim has since left by spawning. */
const respawned = (claim: Claim, record: LadderRecord | undefined): boolean =>
  record !== undefined &&
  (record.respawns > 0 ||
    (record.occurrence !== undefined && record.occurrence !== claim.phaseAt && claim.respawn === undefined))

const respawnCount = (claim: Claim, record: LadderRecord | undefined): number =>
  Math.max(respawned(claim, record) ? 1 : 0, record?.respawns ?? 0)

const rungFor = (claim: Claim, record: LadderRecord | undefined): Rung =>
  claim.worktree !== undefined && !respawned(claim, record) ? 'respawn' : 'stall-owner'

/** Rung 1's first tick: mark the claim and retire its agents, newest first. */
function startRespawn({ claim, code }: Trigger, record: LadderRecord | undefined, now: Date): Action[] {
  const key = keyOf(claim)
  const occurrence = claim.phaseAt
  const counted = { respawns: record?.respawns ?? 0, lastAt: now.toISOString(), occurrence }
  return [
    { kind: 'update', key, patch: { respawn: { code, occurrence } } },
    { kind: 'ladder', key, record: counted },
    { ...retireAll(claim), held: true },
  ]
}

function stallOwner({ claim, code }: Trigger, record: LadderRecord | undefined, now: Date): Action[] {
  const at = now.toISOString()
  const respawns = respawnCount(claim, record)
  return [
    parkUpdate(keyOf(claim), code, 'ladder exhausted after a respawn'),
    { kind: 'ladder', key: keyOf(claim), record: { ...record, respawns, lastAt: at, owner: at } },
  ]
}

/** A stall update is replaced by its rung; a finding update stays, so the finding is still recorded. */
function climb(action: Update, trigger: Trigger, ledger: Ledger, deps: LadderDeps): Action[] {
  const record = ledger.ladder?.[claimKey(trigger.claim)]
  const kept = action.patch.stallCode === undefined ? [action] : []
  const rung =
    rungFor(trigger.claim, record) === 'respawn'
      ? startRespawn(trigger, record, deps.now)
      : stallOwner(trigger, record, deps.now)
  return [...kept, ...rung]
}

type Marked = Claim & { respawn: NonNullable<Claim['respawn']> }

/** Rung 1's later ticks: retire whatever is still live, else spawn the successor, whose intent clears the mark. */
function continueRespawn(claim: Marked, deps: LadderDeps): Action[] {
  const retire = retireAll(claim)
  const live = retire.names.filter(deps.live)
  if (live.length > 0) return [{ ...retire, names: live, held: true }]
  const diffSummary = claim.worktree === undefined ? '' : deps.diffSummary(claim.worktree)
  const context = { kind: 'stall' as const, code: claim.respawn.code, diffSummary }
  return successor(claim, context, { respawn: undefined, unretired: undefined })
}

/** Turned off mid-respawn, the claim goes to its owner rather than waiting on a ladder that no longer acts. */
const abandonRespawn = (claim: Marked): Action[] => [
  parkUpdate(keyOf(claim), claim.respawn.code, 'respawn left unfinished: ladder.enabled was turned off'),
  { kind: 'update', key: keyOf(claim), patch: { respawn: undefined } },
]

/** A held claim's respawn under way, and the count of one that has spawned. */
function underWay(claims: readonly Claim[], ledger: Ledger, deps: LadderDeps): Action[] {
  return claims.flatMap((claim): Action[] => {
    const record = ledger.ladder?.[claimKey(claim)]
    if (claim.respawn === undefined) {
      if (record === undefined || record.respawns > 0 || !respawned(claim, record)) return []
      return [{ kind: 'ladder', key: keyOf(claim), record: { ...record, respawns: 1 } }]
    }
    if (claim.stalledReason !== undefined) return []
    const marked = { ...claim, respawn: claim.respawn }
    return deps.enabled ? continueRespawn(marked, deps) : abandonRespawn(marked)
  })
}

/** Rewrites each claim's first ladder-code stall or lease finding into its rung's actions. */
export function ladderActions(
  actions: Action[],
  claims: readonly Claim[],
  ledger: Ledger,
  deps: LadderDeps,
): Laddered {
  const byKey = new Map(claims.map(c => [claimKey(c), c]))
  const seen = new Set<string>()
  const notes: string[] = []
  const out = actions.flatMap(action => {
    const trigger = action.kind === 'update' ? triggerOf(action, byKey) : undefined
    if (action.kind !== 'update' || trigger === undefined) return [action]
    const key = claimKey(trigger.claim)
    if (seen.has(key)) return [action]
    seen.add(key)
    if (deps.enabled) return climb(action, trigger, ledger, deps)
    if (trigger.fresh)
      notes.push(`ladder off: would ${rungFor(trigger.claim, ledger.ladder?.[key])} ${key} (${trigger.code})`)
    return [action]
  })
  return { actions: [...out, ...underWay(claims, ledger, deps)], notes }
}
