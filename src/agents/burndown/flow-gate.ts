import { parseTaskTags } from './task-tags.js'

/**
 * CC-629 S1: the flow gate `planSeat` applies to new implementers. Stop the line refuses every
 * implementer while the service check has failed twice. It exempts `cos:expedite` (tier 0 takes
 * the next free slot) and planners (a plan opens no PR). Pure: the tick reads the check. The
 * downstream WIP limit was dropped (CC-866); seat concurrency caps govern implementer counts.
 */

/** Two consecutive stopping service-check reads; absent, the line runs. */
export interface LineStop {
  previous: string
  current: string
  message: string
}

export interface FlowRefusal {
  kind: 'stop-line'
  reason: string
}

export interface FlowWork {
  tags: readonly string[]
  planner: boolean
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
