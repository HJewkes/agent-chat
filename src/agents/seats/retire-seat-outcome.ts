import type { ShepherdRow } from '../burndown/shepherd.js'
import { BRANCH_PREFIX } from '../isolation/worktree.js'
import type { RetireOutcome } from './retire-outcome.js'

/** TP-1570: the seat end state the broker can tell at retire, so a seat no longer hand-writes it. */
export interface RetireSeatOutcome {
  outcome: 'merged' | 'done'
  pr: string | null
  head: string | null
}

export interface RetireSeatOutcomeInput {
  agent: string
  outcome: RetireOutcome
  /** Every Shepherd row; undefined when Shepherd could not be read. */
  shepherd: readonly ShepherdRow[] | undefined
}

/**
 * `merged` when Shepherd shows the agent's own PR merged, `done` when the agent reported DONE or a
 * Verdict and implements no shepherded PR, else undefined. A report's `PR:` never decides merged,
 * since a reviewer's report names the PR it reviewed.
 */
export function retireSeatOutcome({
  agent,
  outcome,
  shepherd,
}: RetireSeatOutcomeInput): RetireSeatOutcome | undefined {
  if (shepherd === undefined) return undefined
  const own = shepherd.filter(row => row.implementer === agent || row.branch === BRANCH_PREFIX + agent)
  const merged = own.find(isMerged)
  if (merged !== undefined) {
    return {
      outcome: 'merged',
      pr: merged.pr === null ? null : `${merged.repo}#${merged.pr}`,
      head: merged.headSha,
    }
  }
  if (own.length > 0 || outcome.failure_class !== 'none') return undefined
  return { outcome: 'done', pr: outcome.pr, head: outcome.head }
}

/** Shepherd's cleanup retires agents during post-merge, before the row carries its outcome. */
const isMerged = (row: ShepherdRow): boolean => row.outcome?.kind === 'merged' || row.phase === 'post-merge'
