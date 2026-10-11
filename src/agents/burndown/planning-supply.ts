import { briefRefusal, type BriefCheck, type Refusal, type Task } from './eligibility.js'

/**
 * CC-986 slice b: when a seat's dispatchable supply runs under the CC-967 ready floor, the plan sends briefers
 * to its highest-placed no-brief tasks. Pure: the plan passes its order, its tasks and its refusals.
 */

type Row = { initiative: string; id: string }
type TaskOf = (row: Row) => Pick<Task, 'id' | 'tags'> | undefined

/** Tags that mark a task no briefer should plan: a person's step, an umbrella, or a brief already awaiting approval. */
const UNPLANNABLE = ['kind:owner', 'kind:operator', 'kind:epic']

const proposed = (tag: string): boolean => tag === 'brief:proposed' || tag.startsWith('brief:proposed=')

/** The seat's dispatchable supply: unclaimed placed rows with a fresh `brief:ready`, plus its ready slices. */
export function readyDepth(
  order: readonly Row[],
  taskOf: TaskOf,
  check: BriefCheck,
  claimed: ReadonlySet<string>,
  readySlices: number,
): number {
  const ready = order.filter(row => {
    const task = taskOf(row)
    return task !== undefined && !claimed.has(task.id) && briefRefusal(task, check) === undefined
  })
  return ready.length + readySlices
}

/**
 * The rows refused exactly `no-brief`, in the order refused. Reserved tags, claims, backoff and grants are
 * refused earlier, so none reaches here. A `brief:proposed` task is skipped: its briefer ran and it waits on
 * approval, so planning it again would loop.
 */
export function planningCandidates(
  refusals: readonly Refusal[],
  tasks: ReadonlyMap<string, readonly Pick<Task, 'id' | 'tags'>[]>,
): Refusal[] {
  return refusals.filter(r => {
    if (r.kind !== 'no-brief' || r.task === undefined) return false
    const siblings = tasks.get(r.initiative) ?? []
    const task = siblings.find(t => t.id === r.task)
    if (task === undefined) return false
    if (task.tags.some(tag => UNPLANNABLE.includes(tag) || proposed(tag))) return false
    return !siblings.some(t => t.tags.includes(`epic:${r.task}`))
  })
}
