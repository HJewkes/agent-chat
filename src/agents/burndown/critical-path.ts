import type { TaggedTask } from './task-tags.js'

/**
 * CC-627: total float per task from a forward and backward pass over the `dep:` edges inside one
 * milestone, with the estimate in points as the duration. Float 0 means the task is on the critical path.
 *
 * Pure and total: bad input is reported, never thrown.
 * - The milestone is the input list, narrowed to `milestone` when one is given. A `dep:` naming a task
 *   outside it (another milestone, a closed task, an unknown id) is treated as already satisfied: it
 *   constrains nothing and is listed in `externalDeps`.
 * - A missing, NaN, infinite or negative estimate is duration 0 and is listed in `unestimated`, so the
 *   task still carries its edges but adds no points to the path.
 * - Tasks in a dependency cycle (each strongly connected group, or a task depending on itself) are
 *   listed in `cycles` and get no float. Every other task is scheduled, and a `dep:` on a cyclic task
 *   constrains nothing, so with any cycle `length` is only a lower bound (`lowerBound`).
 * - A repeated id keeps its first task.
 */

export interface TaskFloat {
  id: string
  duration: number
  earlyStart: number
  earlyFinish: number
  lateStart: number
  lateFinish: number
  float: number
}

export interface ExternalDep {
  task: string
  dep: string
}

export interface CriticalPathResult {
  /** Every task outside a cycle, in input order. */
  tasks: TaskFloat[]
  /** The zero-float task ids, by early start then input order. */
  criticalPath: string[]
  /** Remaining critical path length in points: the latest early finish. */
  length: number
  /** True when cycles exist: their tasks and the edges through them add nothing, so `length` may be short. */
  lowerBound: boolean
  /** Each cycle's task ids in input order; cycles ordered by their first member. */
  cycles: string[][]
  externalDeps: ExternalDep[]
  unestimated: string[]
}

type Graph = Map<string, TaggedTask>

/** Rounds away the float error that fractional estimates like 0.5 leave behind. */
const round = (points: number) => Math.round(points * 1e6) / 1e6

const isEstimated = (task: TaggedTask) =>
  typeof task.estimate === 'number' && Number.isFinite(task.estimate) && task.estimate >= 0

function buildGraph(tasks: readonly TaggedTask[], milestone: string | undefined): Graph {
  const graph: Graph = new Map()
  for (const task of tasks) {
    const inMilestone = milestone === undefined || task.milestone === milestone
    if (inMilestone && !graph.has(task.id)) graph.set(task.id, task)
  }
  return graph
}

function externalDeps(graph: Graph): ExternalDep[] {
  return [...graph.values()].flatMap(task =>
    task.deps.filter(dep => !graph.has(dep)).map(dep => ({ task: task.id, dep })),
  )
}

interface TarjanState {
  index: Map<string, number>
  low: Map<string, number>
  stack: string[]
  onStack: Set<string>
  groups: string[][]
}

function strongConnect(graph: Graph, id: string, state: TarjanState): void {
  const { index, low, stack, onStack } = state
  index.set(id, index.size)
  low.set(id, index.get(id)!)
  stack.push(id)
  onStack.add(id)
  for (const dep of graph.get(id)!.deps) {
    if (!graph.has(dep)) continue
    if (!index.has(dep)) strongConnect(graph, dep, state)
    if (onStack.has(dep)) low.set(id, Math.min(low.get(id)!, low.get(dep)!))
  }
  if (low.get(id) !== index.get(id)) return
  const group: string[] = []
  let member: string
  do {
    member = stack.pop()!
    onStack.delete(member)
    group.push(member)
  } while (member !== id)
  state.groups.push(group)
}

/** Strongly connected groups of more than one task, plus self-dependent tasks, in input order. */
function findCycles(graph: Graph): string[][] {
  const state: TarjanState = { index: new Map(), low: new Map(), stack: [], onStack: new Set(), groups: [] }
  for (const id of graph.keys()) if (!state.index.has(id)) strongConnect(graph, id, state)
  const order = [...graph.keys()]
  return state.groups
    .filter(group => group.length > 1 || graph.get(group[0]!)!.deps.includes(group[0]!))
    .map(group => group.sort((a, b) => order.indexOf(a) - order.indexOf(b)))
    .sort((a, b) => order.indexOf(a[0]!) - order.indexOf(b[0]!))
}

/** Drops cyclic tasks and every edge that leaves the acyclic set, so each dep is a scheduled task. */
function acyclicGraph(graph: Graph, cyclic: ReadonlySet<string>): Graph {
  const acyclic: Graph = new Map()
  for (const [id, task] of graph) {
    if (cyclic.has(id)) continue
    const deps = task.deps.filter(dep => graph.has(dep) && !cyclic.has(dep))
    acyclic.set(id, { ...task, deps })
  }
  return acyclic
}

function successorsOf(graph: Graph): Map<string, string[]> {
  const successors = new Map([...graph.keys()].map(id => [id, [] as string[]]))
  for (const task of graph.values()) for (const dep of task.deps) successors.get(dep)!.push(task.id)
  return successors
}

/** Kahn's algorithm in O(tasks + edges), seeded in input order; the graph is acyclic, so every task is placed. */
function topologicalOrder(graph: Graph): string[] {
  const successors = successorsOf(graph)
  const pending = new Map([...graph].map(([id, task]) => [id, task.deps.length]))
  const order = [...pending].filter(([, count]) => count === 0).map(([id]) => id)
  for (let next = 0; next < order.length; next++) {
    for (const successor of successors.get(order[next]!)!) {
      const left = pending.get(successor)! - 1
      pending.set(successor, left)
      if (left === 0) order.push(successor)
    }
  }
  return order
}

const durationOf = (task: TaggedTask) => (isEstimated(task) ? task.estimate! : 0)

function forwardPass(graph: Graph, order: readonly string[]): Map<string, number> {
  const earlyFinish = new Map<string, number>()
  for (const id of order) {
    const task = graph.get(id)!
    const start = Math.max(0, ...task.deps.map(dep => earlyFinish.get(dep)!))
    earlyFinish.set(id, start + durationOf(task))
  }
  return earlyFinish
}

function backwardPass(graph: Graph, order: readonly string[], length: number): Map<string, number> {
  const successors = successorsOf(graph)
  const lateFinish = new Map<string, number>()
  const lateStart = (id: string) => lateFinish.get(id)! - durationOf(graph.get(id)!)
  for (const id of [...order].reverse()) {
    lateFinish.set(id, Math.min(length, ...successors.get(id)!.map(lateStart)))
  }
  return lateFinish
}

function schedule(graph: Graph): { floats: Map<string, TaskFloat>; length: number } {
  const order = topologicalOrder(graph)
  const earlyFinish = forwardPass(graph, order)
  const length = Math.max(0, ...earlyFinish.values())
  const lateFinish = backwardPass(graph, order, length)
  const floats = new Map<string, TaskFloat>()
  for (const id of order) {
    const duration = durationOf(graph.get(id)!)
    const earlyStart = earlyFinish.get(id)! - duration
    const lateStart = lateFinish.get(id)! - duration
    floats.set(id, {
      id,
      duration,
      earlyStart: round(earlyStart),
      earlyFinish: round(earlyFinish.get(id)!),
      lateStart: round(lateStart),
      lateFinish: round(lateFinish.get(id)!),
      float: round(lateStart - earlyStart),
    })
  }
  return { floats, length: round(length) }
}

/** Total float per task in one milestone, its critical path, and the cycles that kept tasks out. */
export function criticalPath(tasks: readonly TaggedTask[], milestone?: string): CriticalPathResult {
  const graph = buildGraph(tasks, milestone)
  const cycles = findCycles(graph)
  const acyclic = acyclicGraph(graph, new Set(cycles.flat()))
  const { floats, length } = schedule(acyclic)
  const scheduled = [...acyclic.keys()].flatMap(id => floats.get(id) ?? [])
  const critical = scheduled.filter(task => task.float === 0)
  return {
    tasks: scheduled,
    criticalPath: critical.sort((a, b) => a.earlyStart - b.earlyStart).map(task => task.id),
    length,
    lowerBound: cycles.length > 0,
    cycles,
    externalDeps: externalDeps(graph),
    unestimated: [...graph.values()].filter(task => !isEstimated(task)).map(task => task.id),
  }
}
