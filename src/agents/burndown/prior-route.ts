import { classifyTask, profileFor, type TaskFacts } from './classify-task.js'
import { readSlices } from './report.js'
import { readWorkflowTable, workflowTablePath, type WorkflowTable } from './workflow-table.js'

/**
 * CC-638 (PR shape B6): the implementer profile a task-time prior gives a dispatch, behind the
 * `priorRouting` tick key. `off` reads nothing; `shadow` keeps today's profile and notes the change
 * `on` would make; `on` routes by the prior. Pure but for `readPriorRouter`.
 */

export const PRIOR_ROUTINGS = ['off', 'shadow', 'on'] as const
export type PriorRouting = (typeof PRIOR_ROUTINGS)[number]

export interface PriorRouter {
  mode: Exclude<PriorRouting, 'off'>
  table: WorkflowTable
}

export interface Routed {
  profile: string
  note?: string
}

/** The profiles the tick can spawn as an implementer; a prior naming any other keeps today's. */
const DISPATCHABLE: readonly string[] = ['bd-implementer-lite', 'bd-implementer']

/** The profile for a dispatch whose route today gives `today`, and the note when the prior would change it. */
export function priorRoute(router: PriorRouter, facts: TaskFacts, today: string, label: string): Routed {
  const { prior, reason } = classifyTask(router.table, facts)
  const wanted = profileFor(router.table, prior, facts.estimate)
  if (!DISPATCHABLE.includes(wanted) || wanted === today) return { profile: today }
  const change = `${label}: ${today} -> ${wanted} (prior ${prior}: ${reason})`
  return router.mode === 'on'
    ? { profile: wanted, note: `route-change ${change}` }
    : { profile: today, note: `would-route ${change}` }
}

export interface PlanFacts {
  owns: string[]
  points?: number
}

/** The union of the plan's slice owns, or the named slice's owns and points; empty with no plan or a failing one. */
export function planFacts(planText: string | undefined, slice?: string): PlanFacts {
  const slices = planText === undefined ? [] : (readSlices(planText).slices ?? [])
  if (slice === undefined) return { owns: [...new Set(slices.flatMap(s => s.owns))] }
  const named = slices.find(s => s.n === slice)
  if (named === undefined) return { owns: [] }
  return named.points === undefined ? { owns: named.owns } : { owns: named.owns, points: named.points }
}

/** The router for `mode`, or the one note saying why the tick routes as today; `off` touches no file. */
export function readPriorRouter(
  mode: PriorRouting,
  autonomyRoot: string,
): { router?: PriorRouter; note?: string } {
  if (mode === 'off') return {}
  const read = readWorkflowTable(autonomyRoot)
  if (read === undefined)
    return {
      note: `prior routing ${mode}: no workflow table at ${workflowTablePath(autonomyRoot)}; routing as today`,
    }
  if (read.table === undefined)
    return { note: `prior routing ${mode}: workflow table: ${read.problems.join('; ')}; routing as today` }
  return { router: { mode, table: read.table } }
}
