import type { AgentIdentity } from '../../protocol.js'
import { FINISHED_PHASES, type ShepherdRow } from '../../shepherd-client.js'
import { claimKey, type Observation } from '../burndown/advance.js'
import { heldClaims, type Claim, type Ledger, type Phase } from '../burndown/ledger.js'
import { prKeys } from './read-live.js'
import type { Count, CountItem, ExplainCode, LiveSnapshot, PrRow, Read, Roster, Shepherd } from './types.js'

/**
 * CC-984 a: the tick's live count per seat, over K1's `deriveCounts`. Pure: the adapter takes only values the tick
 * has already read, so every held claim with no live agent is named with its verdict, never inferred by subtraction.
 */

export const NOT_READ = 'not read by the tick'

export interface TickInputs {
  now: Date
  tickMs: number
  roster: {
    agents: readonly Pick<AgentIdentity, 'agentId' | 'name' | 'profile' | 'state' | 'cwd'>[]
    partial?: string
  }
  ledger: Ledger
  /** `observe`'s observations: each read claim's `prState`, keyed by `claimKey`. */
  observations: ReadonlyMap<string, Pick<Observation, 'prState'>>
  /** The tick's memoized `shepherd status` rows; undefined when Shepherd could not be read. */
  shepherdRows: readonly ShepherdRow[] | undefined
}

export function tickSnapshot(t: TickInputs): LiveSnapshot {
  const notRead = { error: NOT_READ }
  return {
    now: t.now,
    tickMs: t.tickMs,
    sweepMs: t.tickMs,
    roster: { value: rosterOf(t.roster) },
    processes: notRead,
    sessions: notRead,
    fileClaims: notRead,
    worktrees: {},
    prs: { tick: prRows(t) },
    shepherd: shepherdOf(t.shepherdRows),
    ledger: { value: t.ledger },
    semaphore: notRead,
    parkKept: notRead,
  }
}

function rosterOf(roster: TickInputs['roster']): Roster {
  const rows = roster.agents.map(a => ({
    agentId: a.agentId,
    name: a.name,
    profile: a.profile,
    state: a.state,
    cwd: a.cwd,
  }))
  return roster.partial === undefined ? { rows } : { rows, partial: roster.partial }
}

/**
 * K1 looks a PR up across every read and calls an unfound one unread only when some read failed. A held claim
 * whose PR the tick did not read, or read as unreadable, therefore fails the whole read: a claim whose PR the
 * tick found keeps its verdict, and every other PR is unread rather than "not open" (plan R1).
 */
function prRows(t: TickInputs): Read<PrRow[]> {
  const rows: PrRow[] = []
  let missed: string | undefined
  for (const claim of heldClaims(t.ledger)) {
    if (claim.pr === undefined) continue
    const state = t.observations.get(claimKey(claim))?.prState
    if (state === undefined || state === 'unreadable') missed ??= `PR ${claim.pr} ${state ?? NOT_READ}`
    else if (state.kind !== 'none') rows.push({ pr: claim.pr, state: state.kind })
  }
  return missed === undefined ? { value: rows } : { error: missed }
}

function shepherdOf(rows: readonly ShepherdRow[] | undefined): Read<Shepherd> {
  if (rows === undefined) return { error: 'shepherd status unread' }
  const runs = rows.flatMap(row =>
    row.pr === null
      ? []
      : prKeys(row.repo, row.pr).map(pr => ({ pr, ended: FINISHED_PHASES.includes(row.phase) })),
  )
  return { value: { runs } }
}

export const TRUTH_ROLES = ['implementers', 'reviewers', 'planners'] as const
export type TruthRole = (typeof TRUTH_ROLES)[number]

export interface RoleTruth {
  ledger: number
  /** Absent when the roster was unread: an unread count is never printed as zero live. */
  live?: number
}

export interface LedgerOnly {
  claim: string
  phase?: Phase
  pr?: string
  verdict: 'explained' | 'unexplained' | 'unread'
  code?: ExplainCode
  why?: string
  since?: string
}

export interface SeatTruth {
  roles: Record<TruthRole, RoleTruth>
  ledgerOnly: LedgerOnly[]
  unexplained: number
  unread: number
}

const truthKey = (c: Claim): string => `${c.taskId}${c.slice === undefined ? '' : ` ${c.slice}`}`

/**
 * Every non-agreeing lane-role claim, plus each other held claim K1 cannot account for (unexplained or unread).
 * Explained claims outside the lane roles, such as queued slices, are left out to keep the row small (plan R2).
 */
export function seatTruth(counts: readonly Count[], seat: string, ledger: Ledger): SeatTruth {
  const mine = counts.filter(c => c.seat === seat)
  const claims = new Map(
    heldClaims(ledger)
      .filter(c => c.seat === seat)
      .map(c => [truthKey(c), c]),
  )
  const roles = Object.fromEntries(TRUTH_ROLES.map(id => [id, roleTruth(mine.find(c => c.id === id))]))
  const roleItems = mine.filter(c => isTruthRole(c.id)).flatMap(c => c.items)
  const listed = new Set(roleItems.map(i => i.key))
  const extra = (mine.find(c => c.id === 'claims')?.items ?? []).filter(
    i => (i.verdict.kind === 'unexplained' || i.verdict.kind === 'unread') && !listed.has(i.key),
  )
  const ledgerOnly = [...roleItems, ...extra].flatMap(i => ledgerOnlyOf(i, claims.get(i.key)))
  return {
    roles: roles as Record<TruthRole, RoleTruth>,
    ledgerOnly,
    unexplained: ledgerOnly.filter(e => e.verdict === 'unexplained').length,
    unread: ledgerOnly.filter(e => e.verdict === 'unread').length,
  }
}

const isTruthRole = (id: string): id is TruthRole => (TRUTH_ROLES as readonly string[]).includes(id)

function roleTruth(count: Count | undefined): RoleTruth {
  const ledger = count?.shown.find(s => s.surface === 'ledger')?.value ?? 0
  const live = count?.live?.value
  return live === undefined ? { ledger } : { ledger, live }
}

/** An item names a held claim; an unread count's single reader-failure item names none and is left out. */
function ledgerOnlyOf(item: CountItem, claim: Claim | undefined): LedgerOnly[] {
  const v = item.verdict
  if (v.kind === 'agree' || claim === undefined) return []
  const base = { claim: item.key, phase: claim.phase, ...(claim.pr === undefined ? {} : { pr: claim.pr }) }
  if (v.kind === 'explained') return [{ ...base, verdict: 'explained', code: v.code, since: v.since }]
  return [{ ...base, verdict: v.kind, why: v.why }]
}

const reason = (e: LedgerOnly): string => e.code ?? e.why ?? e.verdict
const liveText = (role: RoleTruth): string => (role.live === undefined ? 'unread' : String(role.live))

/** The tick note for one seat: one number per definition, and every ledger-only claim by name with no tolerance. */
export function truthNote(seat: string, truth: SeatTruth, cap: number): string {
  const role = truth.roles.implementers
  const head = `seat ${seat} implementers live ${liveText(role)} / ledger ${role.ledger} / cap ${cap}`
  if (truth.ledgerOnly.length === 0) return head
  return `${head}; ledger-only: ${truth.ledgerOnly.map(e => `${e.claim} (${reason(e)})`).join(', ')}`
}

export interface DriftAlert {
  text: string
  /** Every unexplained claim now, so a key that cleared drops out of the seat's told set. */
  keys: string[]
}

/** The seat's alert when an unexplained claim is not yet told; escalated and other explained claims never alert. */
export function driftAlert(
  seat: string,
  truth: SeatTruth,
  cap: number,
  alerted: readonly string[] = [],
): DriftAlert | undefined {
  const unexplained = truth.ledgerOnly.filter(e => e.verdict === 'unexplained')
  const told = new Set(alerted)
  if (!unexplained.some(e => !told.has(e.claim))) return undefined
  const role = truth.roles.implementers
  const named = unexplained.map(e => `${e.claim} (${e.why ?? 'no disposition'})`).join(', ')
  const explained = truth.ledgerOnly.filter(e => e.verdict === 'explained').length
  return {
    text: `lane mismatch ${seat}: ledger ${role.ledger}/${cap} vs ${liveText(role)} live; unexplained: ${named}; explained: ${explained}`,
    keys: unexplained.map(e => e.claim),
  }
}

export interface LastTickTruth {
  at: string
  truth: Record<string, SeatTruth>
  /** Each seat's implementer cap from the same row; absent for a seat the tick did not plan. */
  cap: Record<string, number>
}

interface RowSeat {
  truth?: SeatTruth
  roles?: { cap?: { implementers?: number } }
}

/**
 * The truth of the last `burndown-ticks.jsonl` row in a tail read. Undefined when the tail is empty or the row
 * predates CC-984, so no surface prints a pre-truth row as zero; a malformed last line throws.
 */
export function parseLastTickTruth(tail: string): LastTickTruth | undefined {
  const last = tail.trimEnd().split('\n').at(-1)
  if (last === undefined || last === '') return undefined
  const row = JSON.parse(last) as { ts?: unknown; seats?: Record<string, RowSeat> }
  if (typeof row.ts !== 'string' || typeof row.seats !== 'object' || row.seats === null) return undefined
  const truth: Record<string, SeatTruth> = {}
  const cap: Record<string, number> = {}
  for (const [seat, s] of Object.entries(row.seats)) {
    if (s.truth === undefined) continue
    truth[seat] = s.truth
    const implementers = s.roles?.cap?.implementers
    if (typeof implementers === 'number') cap[seat] = implementers
  }
  return Object.keys(truth).length === 0 ? undefined : { at: row.ts, truth, cap }
}
