import { claimKey, retireAll, successor, type Action, type ClaimKey } from './advance.js'
import type { BrakeState, Claim, LadderRecord, Ledger } from './ledger.js'
import { LADDER_CODES, parkUpdate, type StallCode } from './stall-code.js'

/**
 * The triage ladder (CC-660): a claim stopped with a ladder code goes up one
 * rung per occurrence. Rung 3 stalls it for the owner, whose `stalled` seat
 * event is the one notice. Rung 2 (release, CC-698) sits between them: the second
 * occurrence on a key never released lets the claim go and keeps its branch.
 * Pure, apart from the injected readers.
 *
 * Rung 1 spans ticks. The first marks the claim (`respawn`), which `advance`
 * then leaves alone, and retires its agents. A later tick spawns one successor,
 * whose brief carries a diff summary, only once the roster shows every agent
 * retired, so two never share the worktree; a refused retire is retried first.
 * A refused spawn is undone to the marked claim, so the next tick retries it;
 * liveness (CC-671) budgets those retries, so the ladder keeps no failure count.
 * An occurrence is the claim's `phaseAt`, and a respawn counts once the
 * successor's spawn has moved the claim to a new one.
 *
 * The brake (CC-699): `BRAKE_COUNT` new rung-1 or rung-2 occurrences inside
 * `BRAKE_WINDOW_MS` stop rungs 1 and 2 for every claim until the window clears.
 * A braked stall passes through as it would with the ladder off, so no rung is
 * counted and the claim's owner hears of it; rung 3 still acts.
 */

export const BRAKE_COUNT = 3
export const BRAKE_WINDOW_MS = 30 * 60_000

export interface LadderDeps {
  /** `ladder.enabled`; off, the actions pass through and each new occurrence gets one note. */
  enabled: boolean
  /** What a worktree holds; read only for a claim the ladder respawns. */
  diffSummary: (worktree: string) => string
  /** The branch a worktree has checked out; read only for a claim the ladder releases. */
  branch?: (worktree: string) => string | undefined
  /** Whether a named agent may still be running. */
  live: (name: string) => boolean
  now: Date
}

export interface Laddered {
  actions: Action[]
  notes: string[]
  /** The brake's write, when this tick changed it; the caller appends it to the actions. */
  brake: Action[]
}

type Update = Extract<Action, { kind: 'update' }>
type Rung = 'respawn' | 'release' | 'stall-owner'

interface Trigger {
  claim: Claim
  code: StallCode
  /** The claim's stall or finding opened this tick, rather than refreshed. */
  fresh: boolean
}

/** Lease verdicts the ladder acts on; `dirty-uncommitted` gets a checkpoint request and then a notice (checkpoint.ts), not a rung. */
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

/** Rung 1 ran for an earlier occurrence: counted, or started on one the claim has since left by a spawn that went out; a spawn parked retry-spent never did. */
const respawned = (claim: Claim, record: LadderRecord | undefined): boolean =>
  record !== undefined &&
  (record.respawns > 0 ||
    (record.occurrence !== undefined &&
      record.occurrence !== claim.phaseAt &&
      claim.respawn === undefined &&
      claim.stallCode !== 'retry-spent'))

const respawnCount = (claim: Claim, record: LadderRecord | undefined): number =>
  Math.max(respawned(claim, record) ? 1 : 0, record?.respawns ?? 0)

function rungFor(claim: Claim, record: LadderRecord | undefined): Rung {
  if (claim.worktree === undefined) return 'stall-owner'
  if (!respawned(claim, record)) return 'respawn'
  return (record?.releases ?? 0) === 0 ? 'release' : 'stall-owner'
}

/** Rung 1's first tick: mark the claim and retire its agents, newest first. */
function startRespawn({ claim, code }: Trigger, record: LadderRecord | undefined, now: Date): Action[] {
  const key = keyOf(claim)
  const occurrence = claim.phaseAt
  const counted = { ...record, respawns: record?.respawns ?? 0, lastAt: now.toISOString(), occurrence }
  return [
    { kind: 'update', key, patch: { respawn: { code, occurrence } } },
    { kind: 'ladder', key, record: counted },
    { ...retireAll(claim), held: true },
  ]
}

/** Rung 2: the claim lets go, its agents retire (the step layer adds the retire), and the branch stays. */
function release({ claim, code }: Trigger, deps: LadderDeps): Action[] {
  const branch = claim.worktree === undefined ? undefined : deps.branch?.(claim.worktree)
  return [
    {
      kind: 'release',
      key: keyOf(claim),
      requeue: claim.slice !== undefined,
      code,
      names: retireAll(claim).names.filter(deps.live),
      ...(branch === undefined ? {} : { branch }),
    },
  ]
}

function stallOwner({ claim, code }: Trigger, record: LadderRecord | undefined, now: Date): Action[] {
  const at = now.toISOString()
  const respawns = respawnCount(claim, record)
  const why = respawns > 0 ? 'ladder exhausted after a respawn' : 'no worktree for a respawn to adopt'
  return [
    parkUpdate(keyOf(claim), code, why),
    { kind: 'ladder', key: keyOf(claim), record: { ...record, respawns, lastAt: at, owner: at } },
  ]
}

/** A stall update is replaced by its rung; a finding update stays, so the finding is still recorded. */
function climb(action: Update, trigger: Trigger, ledger: Ledger, deps: LadderDeps): Action[] {
  const record = ledger.ladder?.[claimKey(trigger.claim)]
  const kept = action.patch.stallCode === undefined ? [action] : []
  const rung = rungFor(trigger.claim, record)
  if (rung === 'release') return release(trigger, deps)
  return [
    ...kept,
    ...(rung === 'respawn' ? startRespawn(trigger, record, deps.now) : stallOwner(trigger, record, deps.now)),
  ]
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

/** A held claim's respawn under way, unless braked, and the count of one that has spawned. */
function underWay(
  claims: readonly Claim[],
  ledger: Ledger,
  deps: LadderDeps & { braked: boolean },
): Action[] {
  return claims.flatMap((claim): Action[] => {
    const record = ledger.ladder?.[claimKey(claim)]
    if (claim.respawn === undefined) {
      if (record === undefined || record.respawns > 0 || !respawned(claim, record)) return []
      return [{ kind: 'ladder', key: keyOf(claim), record: { ...record, respawns: 1 } }]
    }
    // Braked, a respawn under way holds rather than spawning its successor.
    if (claim.stalledReason !== undefined || deps.braked) return []
    const marked = { ...claim, respawn: claim.respawn }
    return deps.enabled ? continueRespawn(marked, deps) : abandonRespawn(marked)
  })
}

/** Each claim's first trigger, keyed by the action that carries it. */
function firstTriggers(actions: readonly Action[], claims: readonly Claim[]): Map<Action, Trigger> {
  const byKey = new Map(claims.map(c => [claimKey(c), c]))
  const seen = new Set<string>()
  const out = new Map<Action, Trigger>()
  for (const action of actions) {
    const trigger = action.kind === 'update' ? triggerOf(action, byKey) : undefined
    if (trigger === undefined || seen.has(claimKey(trigger.claim))) continue
    seen.add(claimKey(trigger.claim))
    out.set(action, trigger)
  }
  return out
}

const actsBelowOwner = (rung: Rung): boolean => rung !== 'stall-owner'

/** The brake's times inside the window ending `now`; a tick and a status read prune by it. */
export const brakeTimes = (brake: BrakeState | undefined, now: Date): string[] =>
  (brake?.at ?? []).filter(t => now.getTime() - Date.parse(t) < BRAKE_WINDOW_MS)

const mostCommon = (codes: readonly StallCode[]): StallCode | undefined => {
  const counts = new Map<StallCode, number>()
  for (const c of codes) counts.set(c, (counts.get(c) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
}

const occurrenceOf = (claim: Claim): string => `${claimKey(claim)}@${claim.phaseAt}`

/**
 * This tick's brake: prior times pruned, and one time added per rung-1 or rung-2 occurrence not counted before.
 * A lifted brake forgets its notice; `seen` keeps only occurrences a held claim still sits on.
 */
function nextBrake(
  triggers: readonly Trigger[],
  claims: readonly Claim[],
  ledger: Ledger,
  now: Date,
): BrakeState {
  const prior = brakeTimes(ledger.brake, now)
  const current = new Set(claims.map(occurrenceOf))
  const seen = (ledger.brake?.seen ?? []).filter(o => current.has(o))
  const counted = triggers
    .filter(t => actsBelowOwner(rungFor(t.claim, ledger.ladder?.[claimKey(t.claim)])))
    .map(t => occurrenceOf(t.claim))
    .filter(o => !seen.includes(o))
  const at = [...prior, ...counted.map(() => now.toISOString())]
  const held = prior.length >= BRAKE_COUNT ? ledger.brake : undefined
  const kept = [...seen, ...counted]
  return {
    at,
    ...(held?.notified === undefined ? {} : { notified: held.notified }),
    ...(held?.claims === undefined ? {} : { claims: held.claims }),
    ...(kept.length === 0 ? {} : { seen: kept }),
  }
}

/**
 * One notice per cause per brake: `notified` and the keys whose seats are told change only on a new cause.
 * The keys are every claim the brake holds: this tick's suppressed stalls and each respawn under way (CC-829).
 */
function noticed(brake: BrakeState, suppressed: readonly Trigger[], claims: readonly Claim[]): BrakeState {
  const cause = mostCommon(suppressed.map(t => t.code))
  if (cause === undefined || brake.notified === `brake:${cause}`) return brake
  const keys = new Set(suppressed.map(t => claimKey(t.claim)))
  const held = claims.filter(
    c => keys.has(claimKey(c)) || (c.respawn !== undefined && c.stalledReason === undefined),
  )
  return { ...brake, notified: `brake:${cause}`, claims: held.map(claimKey) }
}

/** A claim that finishes drops its ladder record, so a re-opened task starts clean (CC-829). */
function pruned(actions: readonly Action[], ledger: Ledger): Action[] {
  return actions.flatMap((a): Action[] =>
    a.kind === 'update' && a.patch.phase === 'done' && ledger.ladder?.[claimKey(a.key)] !== undefined
      ? [{ kind: 'ladder', key: a.key }]
      : [],
  )
}

const sameBrake = (a: BrakeState | undefined, b: BrakeState): boolean =>
  JSON.stringify(a ?? { at: [] }) === JSON.stringify(b)

const brakeAction = (before: BrakeState | undefined, after: BrakeState): Action[] => {
  if (sameBrake(before, after)) return []
  const empty = after.at.length === 0 && after.seen === undefined
  return [empty ? { kind: 'brake' } : { kind: 'brake', brake: after }]
}

/** Rewrites each claim's first ladder-code stall or lease finding into its rung's actions, unless braked. */
export function ladderActions(
  actions: Action[],
  claims: readonly Claim[],
  ledger: Ledger,
  deps: LadderDeps,
): Laddered {
  const triggers = firstTriggers(actions, claims)
  const notes: string[] = []
  const brake = deps.enabled ? nextBrake([...triggers.values()], claims, ledger, deps.now) : undefined
  const braked = brake !== undefined && brake.at.length >= BRAKE_COUNT
  const suppressed: Trigger[] = []
  const out = actions.flatMap(action => {
    const trigger = triggers.get(action)
    if (action.kind !== 'update' || trigger === undefined) return [action]
    const key = claimKey(trigger.claim)
    const rung = rungFor(trigger.claim, ledger.ladder?.[key])
    if (braked && actsBelowOwner(rung)) {
      suppressed.push(trigger)
      return [action]
    }
    if (deps.enabled) return climb(action, trigger, ledger, deps)
    if (trigger.fresh) notes.push(`ladder off: would ${rung} ${key} (${trigger.code})`)
    return [action]
  })
  const after = brake === undefined ? undefined : noticed(brake, suppressed, claims)
  return {
    actions: [
      ...out,
      ...underWay(claims, ledger, { ...deps, braked }),
      ...(deps.enabled ? pruned(actions, ledger) : []),
    ],
    notes,
    brake: after === undefined ? [] : brakeAction(ledger.brake, after),
  }
}

export interface Released {
  taskId: string
  slice?: string
  seat?: string
  code?: StallCode
  branch?: string
  /** The task's release count, which sets its backoff. */
  n: number
}

function releasedOf(key: string, record: LadderRecord, ledger: Ledger): Released {
  const [taskId = '', slice] = key.split('#')
  return {
    taskId,
    n: ledger.releases?.[taskId]?.n ?? record.releases ?? 1,
    ...(slice === undefined || slice === '' ? {} : { slice }),
    ...(record.seat === undefined ? {} : { seat: record.seat }),
    ...(record.code === undefined ? {} : { code: record.code }),
    ...(record.branch === undefined ? {} : { branch: record.branch }),
  }
}

/** The releases a tick made: each ladder key whose count rose between two ledgers. */
export function releasesSince(before: Ledger, after: Ledger): Released[] {
  return Object.entries(after.ladder ?? {}).flatMap(([key, record]) =>
    (record.releases ?? 0) <= (before.ladder?.[key]?.releases ?? 0) ? [] : [releasedOf(key, record, after)],
  )
}

/** Earlier releases whose seat notice did not land, so it is sent again (CC-829). */
export const releasesDue = (ledger: Ledger): Released[] =>
  Object.entries(ledger.ladder ?? {}).flatMap(([key, record]) =>
    record.releaseDue === true ? [releasedOf(key, record, ledger)] : [],
  )

export interface BrakeNotice {
  cause: StallCode
  /** Occurrences inside the window. */
  count: number
  /** The braked claim keys, each with its seat when the claim has one. */
  claims: { key: string; seat?: string }[]
}

/** The brake notice a tick made: `brake.notified` changed to a new cause between two ledgers. */
export function brakeSince(before: Ledger, after: Ledger): BrakeNotice | undefined {
  const notified = after.brake?.notified
  if (notified === undefined || notified === before.brake?.notified) return undefined
  const cause = notified.slice('brake:'.length) as StallCode
  const seatOf = (key: string): string | undefined =>
    [...after.claims, ...before.claims].find(c => claimKey(c) === key)?.seat
  const claims = (after.brake?.claims ?? []).map(key => {
    const seat = seatOf(key)
    return seat === undefined ? { key } : { key, seat }
  })
  return { cause, count: after.brake?.at.length ?? 0, claims }
}
