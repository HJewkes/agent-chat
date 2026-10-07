import { claimKey, retireAll, successor, type Action, type ClaimKey } from './advance.js'
import type { Claim, LadderRecord, Ledger } from './ledger.js'
import { LADDER_CODES, parkUpdate, type StallCode } from './stall-code.js'

/**
 * The triage ladder (CC-660): a claim stopped with a ladder code goes up one
 * rung per occurrence. Rung 1 retires its agents and spawns one successor whose
 * brief carries a diff summary; rung 3 stalls it for the owner, whose `stalled`
 * seat event is the one notice. Rung 2 (release) is CC-698; until it lands a
 * second occurrence goes to rung 3. Pure, apart from the injected diff reader.
 *
 * An occurrence is the claim's `phaseAt`: a respawn starts a new phase, and a
 * refused respawn is undone to the same one, so it retries rung 1 rather than
 * climbing. The respawn spawn is budgeted by liveness (CC-671), so the ladder
 * keeps no failure count of its own.
 */

export interface LadderDeps {
  /** `ladder.enabled`; off, the actions pass through and each new occurrence gets one note. */
  enabled: boolean
  /** What a worktree holds; read only for a claim the ladder respawns. */
  diffSummary: (worktree: string) => string
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

function rungFor(claim: Claim, record: LadderRecord | undefined): Rung {
  if (claim.worktree === undefined) return 'stall-owner'
  if (record === undefined || record.respawns === 0 || record.occurrence === claim.phaseAt) return 'respawn'
  return 'stall-owner'
}

function respawn({ claim, code }: Trigger, worktree: string, deps: LadderDeps): Action[] {
  const context = { kind: 'stall' as const, code, diffSummary: deps.diffSummary(worktree) }
  const record = { respawns: 1, lastAt: deps.now.toISOString(), occurrence: claim.phaseAt }
  return [retireAll(claim), ...successor(claim, context, {}), { kind: 'ladder', key: keyOf(claim), record }]
}

function stallOwner({ claim, code }: Trigger, record: LadderRecord | undefined, now: Date): Action[] {
  const at = now.toISOString()
  return [
    parkUpdate(keyOf(claim), code, 'ladder exhausted after a respawn'),
    { kind: 'ladder', key: keyOf(claim), record: { respawns: 0, ...record, lastAt: at, owner: at } },
  ]
}

/** A stall update is replaced by its rung; a finding update stays, so the finding is still recorded. */
function climb(action: Update, trigger: Trigger, ledger: Ledger, deps: LadderDeps): Action[] {
  const record = ledger.ladder?.[claimKey(trigger.claim)]
  const kept = action.patch.stallCode === undefined ? [action] : []
  const worktree = trigger.claim.worktree
  const rung =
    rungFor(trigger.claim, record) === 'respawn' && worktree !== undefined
      ? respawn(trigger, worktree, deps)
      : stallOwner(trigger, record, deps.now)
  return [...kept, ...rung]
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
  return { actions: out, notes }
}
