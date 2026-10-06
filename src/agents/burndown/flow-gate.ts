import { parseTaskTags } from './task-tags.js'

/**
 * CC-629 S1: the two flow gates `planSeat` applies to new implementers. Stop the line refuses every
 * implementer while the service check has failed twice; downstream WIP refuses one in a repo whose
 * PRs waiting on review, the owner or merge reach the limit. Both exempt `cos:expedite` (tier 0 takes
 * the next free slot) and planners (a plan opens no PR). Pure: the tick reads Shepherd and the check.
 */

/** The repo's PRs past the implementer, or why they could not be counted (which fails closed). */
export type Downstream =
  | {
      /** `owner/name`, for the reason text. */
      name: string
      count: number
      limit: number
      /** The setting the limit came from, as `worktrees.capName` names its cap. */
      setting: string
    }
  /** Why the count is missing, e.g. `could not read Shepherd status`. */
  | { unknown: string }

/** Two consecutive stopping service-check reads; absent, the line runs. */
export interface LineStop {
  previous: string
  current: string
  message: string
}

export interface FlowRefusal {
  kind: 'wip' | 'stop-line'
  reason: string
}

export interface FlowWork {
  tags: readonly string[]
  planner: boolean
}

/** The default WIP limit: twice the seat's reviewer cap, at least 2 so a seat reviewing through Shepherd still runs. */
export function wipLimitFor(reviewers: number, override?: number): { limit: number; setting: string } {
  if (override !== undefined) return { limit: override, setting: 'wip_limit' }
  return { limit: Math.max(2, 2 * reviewers), setting: '2x concurrency.reviewers, at least 2' }
}

const exempt = (work: FlowWork): boolean =>
  work.planner || parseTaskTags({ id: '', tags: work.tags }).task.cos === 'expedite'

export function stopLineRefusal(work: FlowWork, stop: LineStop | undefined): FlowRefusal | undefined {
  if (stop === undefined || exempt(work)) return undefined
  return {
    kind: 'stop-line',
    reason: `service check failed twice (${stop.previous}, then ${stop.current}): ${stop.message}; only cos:expedite dispatches`,
  }
}

export function wipRefusal(
  work: FlowWork,
  repo: string,
  downstream: Downstream | undefined,
): FlowRefusal | undefined {
  if (downstream === undefined || exempt(work)) return undefined
  if ('unknown' in downstream)
    return { kind: 'wip', reason: `${downstream.unknown}, so downstream WIP for ${repo} is unknown` }
  const { name, count, limit, setting } = downstream
  if (count < limit) return undefined
  return {
    kind: 'wip',
    reason: `${name} has ${count} PRs in review or waiting, at its WIP limit of ${limit} (${setting})`,
  }
}
