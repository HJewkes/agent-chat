import { capGate, type GateReading } from './gate-reading.js'
import type { ReviewBacklog } from './review-backlog.js'
import { parseTaskTags } from './task-tags.js'

/**
 * CC-629 S1: the flow gate `planSeat` applies to new implementers. Stop the line refuses every
 * implementer while the service check has failed twice. It exempts `cos:expedite` (tier 0 takes
 * the next free slot) and planners (a plan opens no PR). Pure: the tick reads the check. The
 * downstream WIP limit was dropped (CC-866); seat concurrency caps govern implementer counts.
 * CC-1106 adds review backpressure: queued reviews against Shepherd's review cap, which fails open.
 */

/** Two consecutive stopping service-check reads; absent, the line runs. */
export interface LineStop {
  previous: string
  current: string
  message: string
}

export interface FlowRefusal {
  kind: 'stop-line' | 'review-backpressure'
  reason: string
  gate?: GateReading
}

export const REVIEW_BACKPRESSURE_MODES = ['off', 'shadow', 'on'] as const

/** CC-1106: `burndown.reviewBackpressure`; `shadow` notes what `on` would refuse. */
export interface ReviewBackpressure {
  mode: (typeof REVIEW_BACKPRESSURE_MODES)[number]
  k: number
}

/** What the gate says without refusing: an unread backlog, or a shadow gate's would-refuse. */
export interface FlowNote {
  note: string
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

const BACKPRESSURE_LEVER = 'burndown.reviewBackpressure.k'
const BACKPRESSURE_SOURCE = 'shepherd status reviewSlots'

/**
 * Refuses a new implementer while more reviews queue than `k` times Shepherd's review cap. An unread
 * backlog refuses nothing and says so: a wrongly held line stalls the factory, and this is a flow control.
 */
export function reviewBackpressureRefusal(
  work: FlowWork,
  backlog: ReviewBacklog | undefined,
  cfg: ReviewBackpressure | undefined,
): FlowRefusal | FlowNote | undefined {
  if (backlog === undefined || cfg === undefined || cfg.mode === 'off' || exempt(work)) return undefined
  if ('unknown' in backlog)
    return { note: `review backpressure unread, implementers dispatch: ${backlog.unknown}` }
  const limit = cfg.k * backlog.cap
  if (backlog.queued <= limit) return undefined
  const reason = `${backlog.queued} reviews queued (${backlog.waiting} waiting, ${backlog.running} running) above ${cfg.k} x cap ${backlog.cap}`
  if (cfg.mode === 'shadow') return { note: `would-refuse review-backpressure: ${reason}` }
  return {
    kind: 'review-backpressure',
    reason,
    gate: capGate(BACKPRESSURE_LEVER, limit, backlog.queued, BACKPRESSURE_SOURCE),
  }
}
