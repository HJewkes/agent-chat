import type { Milestone } from './milestones.js'
import type { TaggedTask } from './task-tags.js'

/** CC-720: the lint for `ms-role:criterion` tasks. Pure; reports, never refuses. */

export interface UnnamedCriterion {
  task: string
  /** The task's `milestone:` tag, or undefined when it has none. */
  milestone?: string
}

function namedIds(milestone: Milestone | undefined): Set<string> {
  const checks = milestone?.doneWhen ?? []
  return new Set(checks.flatMap(check => [...(check.tasks ?? []), ...(check.epics ?? [])]))
}

/** Each open criterion task that no check of its milestone names by its id or its `epic:`; one with no known milestone is unnamed. */
export function unnamedCriteria(
  tasks: readonly TaggedTask[],
  milestones: readonly Milestone[],
): UnnamedCriterion[] {
  const byId = new Map(milestones.map(m => [m.id, m]))
  return tasks
    .filter(t => t.msRole === 'criterion')
    .filter(t => {
      const named = namedIds(t.milestone === undefined ? undefined : byId.get(t.milestone))
      return !named.has(t.id) && !(t.epic !== undefined && named.has(t.epic))
    })
    .map(t => ({ task: t.id, ...(t.milestone !== undefined && { milestone: t.milestone }) }))
}

export const describeUnnamedCriterion = ({ task, milestone }: UnnamedCriterion): string =>
  `unnamed-criterion ${task} ${milestone === undefined ? 'no milestone' : `milestone:${milestone}`}`
