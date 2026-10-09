import type { Refusal, RefusalKind } from './eligibility.js'
import type { SeatState } from './ledger.js'

/**
 * CC-859 (charter 3.5 and 4.2): a seat tick that dispatches nothing says why in the seat's log, once.
 * The line names the stop that applied with its reading, else the refusal counts by kind. It is
 * written again only when the reason set changes or an hour has passed, so a ten-minute tick that
 * keeps refusing for the same reasons writes one line an hour, not six.
 */

/** Every line starts with this, so it never starts with a seat's WRAP, PARKED or BUDGET-PAUSE marker. */
export const NO_DISPATCH_PREFIX = 'burndown: dispatched nothing'

export const NO_DISPATCH_REPEAT_MS = 3_600_000

/** What one seat's planning came to this tick; `skipped` when it could not be loaded or planned. */
export interface SeatOutcome {
  seat: string
  dispatched: number
  refusals: readonly Refusal[]
  skipped?: string
}

export interface NoDispatchReason {
  seat: string
  /** The reason set, without readings or counts, which change every tick. */
  key: string
  text: string
}

const STOPS: { name: string; kinds: readonly RefusalKind[] }[] = [
  { name: 'machine stop', kinds: ['stop-line'] },
  { name: 'budget stop', kinds: ['budget'] },
  { name: 'full cap', kinds: ['slots', 'role-cap', 'worktrees'] },
]

const READING_MAX = 200

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, READING_MAX)

function counts(refusals: readonly Refusal[]): [string, number][] {
  const byKind = new Map<string, number>()
  for (const r of refusals) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1)
  return [...byKind].sort(([a, m], [b, n]) => n - m || a.localeCompare(b))
}

/** The stop that applied, first in STOPS order, with the reading of its first refusal. */
function stopOf(refusals: readonly Refusal[]): { name: string; reading: string } | undefined {
  for (const stop of STOPS) {
    const hit = refusals.find(r => stop.kinds.includes(r.kind))
    if (hit !== undefined) return { name: stop.name, reading: oneLine(hit.reason) }
  }
  return undefined
}

/** The seat's reason line, or undefined when it dispatched. */
export function noDispatchReason(outcome: SeatOutcome): NoDispatchReason | undefined {
  const { seat, refusals, skipped } = outcome
  if (skipped !== undefined)
    return { seat, key: 'skipped', text: `${NO_DISPATCH_PREFIX}; seat skipped: ${oneLine(skipped)}` }
  if (outcome.dispatched > 0) return undefined
  if (refusals.length === 0)
    return { seat, key: 'exhausted', text: `${NO_DISPATCH_PREFIX}; scope exhausted: no open task in scope` }
  const tally = counts(refusals)
  const stop = stopOf(refusals)
  const listed = `refusals ${tally.map(([kind, n]) => `${kind} ${n}`).join(', ')}`
  const head = stop === undefined ? '' : `; ${stop.name}: ${stop.reading}`
  const kinds = tally.map(([kind]) => kind).sort()
  return {
    seat,
    key: [stop?.name ?? '-', ...kinds].join(' '),
    text: `${NO_DISPATCH_PREFIX}${head}; ${listed}`,
  }
}

/** Whether the seat's last line, `mark`, leaves this reason unsaid: a new reason set, or an hour gone. */
export function isDue(mark: SeatState['noDispatch'], key: string, now: Date): boolean {
  if (mark === undefined || mark.key !== key) return true
  return now.getTime() - Date.parse(mark.at) >= NO_DISPATCH_REPEAT_MS
}

/**
 * The lines due this tick and each seat's state with its mark updated. A seat that dispatched drops
 * its mark, so the next empty tick says so at once.
 */
export function dueReasons(
  outcomes: readonly SeatOutcome[],
  states: Record<string, SeatState>,
  now: Date,
): { due: NoDispatchReason[]; states: Record<string, SeatState> } {
  const next = { ...states }
  const due: NoDispatchReason[] = []
  for (const outcome of outcomes) {
    const { noDispatch, ...state } = next[outcome.seat] ?? { samples: [] }
    const reason = noDispatchReason(outcome)
    if (reason === undefined) next[outcome.seat] = state
    else if (!isDue(noDispatch, reason.key, now)) continue
    else {
      due.push(reason)
      next[outcome.seat] = { ...state, noDispatch: { key: reason.key, at: now.toISOString() } }
    }
  }
  return { due, states: next }
}
