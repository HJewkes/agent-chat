import type { TagError, TaggedTask } from './task-tags.js'

/**
 * CC-644: the `dep:` edges the plan refuses, each as a line that names its task ids, and the tasks
 * behind a failed upstream. Pure; `planOrder` holds the refused tasks, this names why.
 */

/** Task id to why its work failed, such as a failed or released stall; read from the ledger by the caller. */
export type FailedUpstreams = Readonly<Record<string, string>>

/** One cycle as `A -> B -> A`: the shortest way back to the group's first task, which the SCC guarantees exists. */
function cycleWitness(group: readonly string[], deps: ReadonlyMap<string, readonly string[]>): string[] {
  const start = group[0]!
  const inGroup = new Set(group)
  const previous = new Map<string, string>()
  const queue = [start]
  for (let next = 0; next < queue.length; next++) {
    const id = queue[next]!
    for (const dep of deps.get(id) ?? []) {
      if (!inGroup.has(dep)) continue
      if (dep === start) return [start, ...pathTo(previous, id, start), start]
      if (previous.has(dep)) continue
      previous.set(dep, id)
      queue.push(dep)
    }
  }
  return [start, start]
}

/** The ids after `start` up to and including `id`, following `previous` back from `id`. */
function pathTo(previous: ReadonlyMap<string, string>, id: string, start: string): string[] {
  const path: string[] = []
  for (let at = id; at !== start; at = previous.get(at)!) path.unshift(at)
  return path
}

/** `self-dep <id>` for a task naming itself, else `cycle A -> B -> A`, one per cyclic group. */
export function cycleLines(cycles: readonly string[][], tagged: readonly TaggedTask[]): string[] {
  const deps = new Map(tagged.map(task => [task.id, task.deps]))
  return cycles.map(group => {
    const path = cycleWitness(group, deps)
    return path.length === 2 ? `self-dep ${path[0]}` : `cycle ${path.join(' -> ')}`
  })
}

/** `unknown-dep <task> -> <dep>` for each `dep:` naming no known task. */
export const unknownDepLines = (errors: readonly TagError[]): string[] =>
  errors
    .filter(e => e.code === 'unknown-dep')
    .map(e => `unknown-dep ${e.task} -> ${e.tag.slice('dep:'.length)}`)

/** A task held because an upstream failed, with the failed root and the task one step toward it. */
export interface UpstreamBlock {
  task: string
  root: string
  why: string
  via?: string
}

/**
 * Every task that reaches a failed upstream through `dep:` edges, direct and transitive, with the root named.
 * The failed task itself is not listed: whether to retry it is the ledger's call.
 */
export function upstreamBlocks(tagged: readonly TaggedTask[], failed: FailedUpstreams): UpstreamBlock[] {
  const dependents = new Map<string, string[]>()
  for (const task of tagged)
    for (const dep of task.deps) dependents.set(dep, [...(dependents.get(dep) ?? []), task.id])
  const blocks = new Map<string, UpstreamBlock>()
  for (const root of Object.keys(failed).sort()) {
    const queue = [root]
    for (let next = 0; next < queue.length; next++) {
      const id = queue[next]!
      for (const task of dependents.get(id) ?? []) {
        if (task === root || blocks.has(task)) continue
        blocks.set(task, { task, root, why: failed[root]!, ...(id !== root && { via: id }) })
        queue.push(task)
      }
    }
  }
  return [...blocks.values()]
}

export const upstreamLine = ({ task, root, why, via }: UpstreamBlock): string =>
  `blocked ${task}: upstream ${root} failed (${why})${via === undefined ? '' : ` via ${via}`}`
