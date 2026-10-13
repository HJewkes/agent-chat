import type { Task } from './eligibility.js'
import type { Ledger } from './ledger.js'
import type { HumanItem } from './seat-deliver.js'

/**
 * CC-1049: a task whose slices all merged is no longer a seeding candidate. The tick flags it
 * once for the owner instead of refusing it plan-blocked every tick. It never closes the task:
 * the tick has no way to tell a code-only `done_when` from one the slices did not cover.
 */

/** True when the task has slice claims and every one is done; a released slice is another case (CC-1227). */
export function slicesMerged(ledger: Ledger, taskId: string): boolean {
  if (ledger.slicesReleased?.[taskId] !== undefined) return false
  const slices = ledger.claims.filter(c => c.taskId === taskId && c.slice !== undefined)
  return slices.length > 0 && slices.every(c => c.phase === 'done')
}

export const mergedFlagKey = (initiative: string, taskId: string): string =>
  `slices-merged:${initiative}/${taskId}`

const isOpen = (task: Task): boolean => task.status === undefined || task.status === 'open'

/** One human-queue item for each open task whose slices all merged and that has not been flagged. */
export function mergedParentFlags(ledger: Ledger, tasks: ReadonlyMap<string, readonly Task[]>): HumanItem[] {
  const filed = new Set(ledger.humanFiled ?? [])
  return [...tasks].flatMap(([initiative, list]) =>
    list
      .filter(t => isOpen(t) && slicesMerged(ledger, t.id) && !filed.has(mergedFlagKey(initiative, t.id)))
      .map(t => ({
        key: mergedFlagKey(initiative, t.id),
        task: t.id,
        text: `${initiative} ${t.id}: slices merged: close or replan`,
      })),
  )
}
