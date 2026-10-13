import type { Observation } from './advance.js'
import type { Claim } from './ledger.js'

/**
 * CC-1150 b: what a stalled claim whose agent is gone is waiting on, and what the seat could do about it.
 * Pure, and it only classifies: nothing here releases or finishes a claim.
 */

export const STALE_CLASSES = [
  'nothing-to-do',
  'date-blocked',
  'retry-spent',
  'pr-closed',
  'blocked',
  'outside-owns',
  'timeout',
  'other',
] as const
export type StaleClass = (typeof STALE_CLASSES)[number]

export interface StaleVerdict {
  class: StaleClass
  proposed: string
  /** On `date-blocked`: the ISO date the claim waits for. */
  until?: string
}

const PROPOSED: Record<StaleClass, string> = {
  'nothing-to-do': 'finish the claim and retire its agents',
  'date-blocked': 'release once the date passes',
  'retry-spent': 'release with requeue, branch kept',
  'pr-closed': 'release with requeue 30 min after the close, branch kept',
  blocked: 'answer the question or release by hand',
  'outside-owns': 'widen the slice owns or drop the files from the PR',
  timeout: 'respawn or release by hand',
  other: 'read the report and settle by hand',
}

/** Only an ISO date after one of these words counts; any other wording is not a date the tick may act on. */
const DATE_AFTER = /\b(?:until|on or after|after)\s+(\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?)\b/i

export const blockedUntil = (text: string): string | undefined => DATE_AFTER.exec(text)?.[1]

const QUESTION = /^Status:\s*(?:BLOCKED|NEEDS_CONTEXT)\b/

const prNone = (pr: string | undefined): boolean => /^none\b/i.test(pr ?? '')

/**
 * CC-1230 a: an exit that said nothing, left no commits, and has no PR on GitHub had nothing to do (TD-829 a).
 * Every read must be fresh and say so; an unreadable or absent read keeps the claim `other`.
 */
function silentAndEmpty({ report, exitedWork, prState }: Observation): boolean {
  const silent = report === undefined || (report.status === 'unknown' && report.parked === undefined)
  const empty = typeof exitedWork === 'object' && exitedWork.openPr === null && exitedWork.ahead === 0
  return silent && empty && typeof prState === 'object' && prState.kind === 'none'
}

function staleClass(claim: Claim, obs: Observation): Omit<StaleVerdict, 'proposed'> {
  const { report, prState } = obs
  const done = report?.status === 'DONE' || report?.status === 'DONE_WITH_CONCERNS'
  if (done && prNone(report?.pr)) return { class: 'nothing-to-do' }
  if (claim.stallCode === 'retry-spent') return { class: 'retry-spent' }
  if (prState !== undefined && prState !== 'unreadable' && prState.kind === 'closed')
    return { class: 'pr-closed' }
  const until = blockedUntil(`${claim.stalledReason ?? ''}\n${report?.text ?? ''}`)
  if (until !== undefined) return { class: 'date-blocked', until }
  const reason = claim.stalledReason ?? ''
  if (QUESTION.test(reason) || report?.status === 'BLOCKED' || report?.status === 'NEEDS_CONTEXT')
    return { class: 'blocked' }
  if (claim.stallCode === 'outside-owns') return { class: 'outside-owns' }
  if (claim.stallCode === 'phase-timeout') return { class: 'timeout' }
  return { class: silentAndEmpty(obs) ? 'nothing-to-do' : 'other' }
}

/** The class of a stalled claim whose agent is gone, with the action the seat is told it could take. */
export function classifyStale(claim: Claim, obs: Observation): StaleVerdict {
  const found = staleClass(claim, obs)
  const proposed = found.until === undefined ? PROPOSED[found.class] : `release on or after ${found.until}`
  return { ...found, proposed }
}
