import fs from 'node:fs'
import path from 'node:path'
import type { OwnerItem, OwnerItemDeposit } from '@titan-design/owner-queue'
import type { Initiative, Task } from './eligibility.js'
import { isHumanStep } from './ops.js'
import { seatScope } from './policy.js'
import { scopeRefusal } from './seat-scope.js'
import { readSeatScope, type LoadedSeat, type OwnerQueuePort } from './seat-tick.js'
import { readTasks } from './source.js'

/**
 * CC-974 slice c: a `kind:owner` or `kind:operator` task never dispatches. Once every `dep:` it names is done, the
 * tick files it once into the owner queue, keyed `human-step:<id>`. The owner-queue item has no audience field, so
 * an operator step goes to the same queue with an `[operator]` summary prefix.
 */

/** One seat's open tasks in scope, by initiative. */
export interface HumanStepSource {
  seat: string
  tasks: ReadonlyMap<string, readonly Task[]>
}

export const humanStepKey = (id: string): string => `human-step:${id}`

const depsOf = (task: Task): string[] =>
  task.tags.filter(tag => tag.startsWith('dep:')).map(tag => tag.slice('dep:'.length))

/** Open human steps whose every `dep:` is done; a step naming no dep is due at once. */
export function dueHumanSteps(tasks: readonly Task[], isDone: (id: string) => boolean): Task[] {
  return tasks.filter(t => t.status === 'open' && isHumanStep(t.tags) && depsOf(t).every(isDone))
}

function humanStepDeposit(seat: string, initiative: string, task: Task): OwnerItemDeposit {
  const operator = task.tags.includes('kind:operator')
  const deps = depsOf(task)
  const after = deps.length === 0 ? '' : ` Its deps are done: ${deps.join(', ')}.`
  return {
    depositId: `human-step-${task.id}`,
    asker: 'burndown-tick',
    kind: 'do',
    door: 'two-way',
    summary: `${operator ? '[operator] ' : ''}${task.id}: ${task.title}`,
    context: `${task.id} (${initiative}) is a ${operator ? 'kind:operator' : 'kind:owner'} step, never dispatched.${after} Done when: ${task.doneWhen ?? '(none)'}`,
    keys: [humanStepKey(task.id)],
    seat,
    initiative,
  }
}

/** Deposits each due step not already open in the queue, once across seats; returns the deposited task ids. */
export async function routeHumanSteps(
  sources: readonly HumanStepSource[],
  isDone: (id: string) => boolean,
  port: OwnerQueuePort,
): Promise<string[]> {
  const due = sources.flatMap(({ seat, tasks }) =>
    [...tasks].flatMap(([initiative, list]) =>
      dueHumanSteps(list, isDone).map(task => ({ seat, initiative, task })),
    ),
  )
  if (due.length === 0) return []
  const filed = new Set((await port.open()).flatMap((item: OwnerItem) => item.keys))
  const routed: string[] = []
  for (const { seat, initiative, task } of due) {
    if (filed.has(humanStepKey(task.id))) continue
    await port.deposit(humanStepDeposit(seat, initiative, task))
    filed.add(humanStepKey(task.id))
    routed.push(task.id)
  }
  return routed
}

/**
 * The tick's step: reads the sources only when called and routes them. A throw, from a reader or the port, is one
 * `burndown_human_steps_failed` event and no lines, never a failed tick.
 */
export async function fileHumanSteps(
  sources: () => readonly HumanStepSource[],
  isDone: (id: string) => boolean,
  port: OwnerQueuePort,
  log: (event: string, detail: Record<string, unknown>) => void,
): Promise<string[]> {
  try {
    const routed = await routeHumanSteps(sources(), isDone, port)
    return routed.map(id => `routed human step ${id} to the owner queue`)
  } catch (err) {
    log('burndown_human_steps_failed', { detail: err instanceof Error ? err.message : String(err) })
    return []
  }
}

/** The seat's scope, as dispatch reads it: its initiatives, narrowed by `scope_tags` in shared ones. */
export function humanStepSource(
  seat: LoadedSeat,
  initiatives: readonly Initiative[],
  root: string,
  aliases?: Readonly<Record<string, string>>,
): HumanStepSource {
  const { charter, seats } = seat.policy
  const name = seat.dispatch.seat
  const { scope } = readSeatScope(seats, name, seat.autonomyRoot, aliases)
  const slugs = Object.keys(seatScope(charter, seats, name, initiatives))
  const tasks = new Map(
    slugs.map(slug => [slug, readTasks(root, slug).filter(t => scopeRefusal(scope, slug, t) === undefined)]),
  )
  return { seat: name, tasks }
}

const listDir = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/** Every task id on disk with status done, in any initiative; an archived task counts as done. */
export function doneIdsOnDisk(root: string): Set<string> {
  const done = new Set<string>()
  for (const slug of listDir(root)) {
    for (const task of readTasks(root, slug)) if (task.status === 'done') done.add(task.id)
    for (const file of listDir(path.join(root, slug, 'tasks', 'archive')))
      if (file.endsWith('.yml')) done.add(file.slice(0, -'.yml'.length))
  }
  return done
}
