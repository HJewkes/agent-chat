import type { DispatchRecord } from '../seats/dispatch-record.js'
import { isStalled, type Claim, type Ledger } from './ledger.js'
import { currentTriage } from './triage.js'
import { rowFor, shepherdTarget, type ShepherdRow } from './shepherd.js'

/**
 * CC-672: who holds each held claim or parked run right now, and why. One custody word per item, from an
 * ordered rule table: the first rule that fires wins, so a stall outranks the phase it stalled in. A fact
 * that could not be read (no phase, no Shepherd answer for a shepherded PR) is `unowned` with that reason,
 * never a guess. Pure: the caller reads the ledger, the Shepherd rows and the dispatch rows.
 */

export const CUSTODY_WORDS = [
  'building',
  'in review',
  'waiting on owner',
  'waiting on world',
  'being fixed',
  'unowned',
] as const
export type CustodyWord = (typeof CUSTODY_WORDS)[number]

export interface Custody {
  word: CustodyWord
  reason: string
}

/** What the rules read. `shepherd` is `undefined` when Shepherd could not be read, `null` when it has no row for the PR. */
export type CustodyFacts =
  | { kind: 'claim'; claim: Claim; now: Date; shepherd: readonly ShepherdRow[] | undefined }
  | { kind: 'run'; run: DispatchRecord }

interface Rule {
  id: string
  /** The custody this rule gives, or undefined when it does not apply. */
  match: (facts: CustodyFacts) => Custody | undefined
}

const custody = (word: CustodyWord, reason: string): Custody => ({ word, reason })

const asClaim = (f: CustodyFacts): Extract<CustodyFacts, { kind: 'claim' }> | undefined =>
  f.kind === 'claim' ? f : undefined

/** The Shepherd row of the claim's PR: undefined when the claim has no PR or Shepherd could not be read. */
function shepherdRowOf(f: Extract<CustodyFacts, { kind: 'claim' }>): ShepherdRow | null | undefined {
  const target = shepherdTarget(f.claim.pr)
  if (target === undefined || f.shepherd === undefined) return undefined
  return rowFor(f.shepherd, target) ?? null
}

const SHEPHERD_PHASES: Partial<Record<ShepherdRow['phase'], Custody>> = {
  fixing: custody('being fixed', 'shepherd is fixing the PR'),
  review: custody('in review', 'shepherd: PR in review'),
  ci: custody('waiting on world', 'shepherd: CI running'),
  'awaiting-pr': custody('waiting on world', 'shepherd: waiting for the PR'),
  merging: custody('waiting on world', 'shepherd: merging'),
  'post-merge': custody('waiting on world', 'shepherd: post-merge checks'),
  done: custody('waiting on world', 'shepherd run done; the claim has not caught up'),
  'awaiting-approval': custody('waiting on owner', 'shepherd: awaiting approval'),
  failed: custody('waiting on owner', 'shepherd run failed'),
  cancelled: custody('waiting on owner', 'shepherd run cancelled'),
  unknown: custody('unowned', 'shepherd reports a phase this build does not know'),
}

const CLAIM_PHASES: Record<Claim['phase'], Custody | undefined> = {
  queued: custody('building', 'queued for a slot'),
  spawning: custody('building', 'agent spawning'),
  planning: custody('building', 'planner working'),
  implementing: custody('building', 'implementer working'),
  reviewing: custody('in review', 'reviewer working'),
  'awaiting-merge': custody('waiting on world', 'PR awaiting merge'),
  parked: custody('waiting on owner', 'parked'),
  shepherding: undefined,
  done: undefined,
}

/** First match wins; the order is the "who acts next" order, so read top to bottom. */
export const CUSTODY_RULES: readonly Rule[] = [
  {
    id: 'no-fact',
    match: f =>
      f.kind === 'claim' && f.claim.phase === undefined
        ? custody('unowned', 'claim phase unreadable')
        : f.kind === 'run' && f.run.outcome === undefined
          ? custody('unowned', 'run outcome unreadable')
          : undefined,
  },
  {
    id: 'shepherd-unreadable',
    match: f => {
      const c = asClaim(f)
      if (c === undefined || c.claim.phase !== 'shepherding') return undefined
      if (shepherdTarget(c.claim.pr) === undefined)
        return custody('unowned', 'shepherding without a readable PR')
      return c.shepherd === undefined ? custody('unowned', 'shepherd unreadable') : undefined
    },
  },
  {
    id: 'triage-running',
    match: f => {
      const c = asClaim(f)
      const outcome = c === undefined ? undefined : currentTriage(c.claim)?.outcome
      return c !== undefined &&
        c.claim.stalledReason !== undefined &&
        (outcome === 'started' || outcome === 'waiting')
        ? custody('being fixed', `triage ${outcome}: ${c.claim.stalledReason}`)
        : undefined
    },
  },
  {
    id: 'stalled',
    match: f => {
      const c = asClaim(f)
      if (c === undefined || !isStalled(c.claim, c.now)) return undefined
      return custody(
        'waiting on owner',
        `stalled: ${c.claim.stalledReason ?? `${c.claim.phase} past its timeout`}`,
      )
    },
  },
  {
    id: 'shepherd-stalled',
    match: f => {
      const c = asClaim(f)
      const row = c === undefined ? undefined : shepherdRowOf(c)
      return row?.stalled == null
        ? undefined
        : custody('waiting on owner', `shepherd stalled: ${row.stalled.reason}`)
    },
  },
  {
    id: 'shepherd-phase',
    match: f => {
      const c = asClaim(f)
      if (c === undefined) return undefined
      const row = shepherdRowOf(c)
      if (row === undefined) return undefined
      if (row === null)
        return c.claim.phase === 'shepherding' ? custody('unowned', 'no shepherd run for the PR') : undefined
      return SHEPHERD_PHASES[row.phase]
    },
  },
  {
    id: 'run-parked',
    match: f => {
      if (f.kind !== 'run') return undefined
      if (f.run.outcome === 'dispatched') {
        return /reviewer$/.test(f.run.profile ?? '')
          ? custody('in review', 'reviewer run open')
          : custody('building', 'run open')
      }
      if (f.run.outcome !== 'parked') return custody('unowned', `run ${f.run.outcome} is not held`)
      const note = String(f.run.note ?? '')
      return /\bMERGE\b/.test(note)
        ? custody('waiting on world', 'parked with a MERGE verdict')
        : custody('waiting on owner', note === '' ? 'parked' : `parked: ${note}`)
    },
  },
  {
    id: 'claim-phase',
    match: f => {
      const c = asClaim(f)
      return c === undefined ? undefined : CLAIM_PHASES[c.claim.phase]
    },
  },
]

/** The one custody of a claim or run; a fact no rule covers is `unowned`. */
export function custodyOf(facts: CustodyFacts): Custody {
  for (const rule of CUSTODY_RULES) {
    const hit = rule.match(facts)
    if (hit !== undefined) return hit
  }
  return custody('unowned', 'no rule matched')
}

/** `<claim> <custody word>: <reason>`, the line `burndown status` prints. */
export const renderCustody = (claim: Claim, c: Custody): string =>
  `${claim.taskId}${claim.slice === undefined ? '' : `/${claim.slice}`} ${c.word}: ${c.reason}`

/** One custody per held claim, in ledger order. */
export function claimCustody(
  claims: Ledger['claims'],
  now: Date,
  shepherd: readonly ShepherdRow[] | undefined,
): string[] {
  return claims.map(claim => renderCustody(claim, custodyOf({ kind: 'claim', claim, now, shepherd })))
}
