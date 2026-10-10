import { briefRefusal, type BriefCheck } from './eligibility.js'
import { parseTaskTags } from './task-tags.js'
import { parseIsoDay } from './score.js'
import { scopeRefusal, type SeatScope } from './seat-scope.js'

/**
 * CC-926 (item 179, S2): the order of a seat's brief-ready rows when its brief gate is `on`. The seat
 * priced the work while writing the brief, so its priority leads and the scorer only breaks ties.
 * Pure; `readyOrder`'s caller passes only rows that are brief-ready, which `readySet` picks.
 */

/** Expedite (0) and fixed-date-at-risk (1) rows keep `planOrder`'s order and go before everything else. */
export const PREEMPT_TIER = 1

export interface ReadyOrderRow {
  id: string
  /** The scorer's score. */
  score: number
  /** `planOrder`'s class-of-service tier; absent when the tick ordered without planning inputs. */
  tier?: number
  /** Initiative weight, the scorer's `W`. */
  components: { W: number }
}

/**
 * Tiers 0-1 first in the order given, then by priority ascending (a missing one last), initiative
 * weight descending, score descending and task id.
 */
export function readyOrder<T extends ReadyOrderRow>(
  rows: readonly T[],
  priorityOf: (row: T) => number | undefined,
): T[] {
  const preempts = (row: T): boolean => row.tier !== undefined && row.tier <= PREEMPT_TIER
  const rest = rows.filter(row => !preempts(row)).sort((a, b) => compare(a, b, priorityOf))
  return [...rows.filter(preempts), ...rest]
}

function compare<T extends ReadyOrderRow>(a: T, b: T, priorityOf: (row: T) => number | undefined): number {
  return (
    (priorityOf(a) ?? Infinity) - (priorityOf(b) ?? Infinity) ||
    b.components.W - a.components.W ||
    b.score - a.score ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

export interface ReadyTask {
  id: string
  tags: readonly string[]
  priority?: number
}

/** CC-928: every `every`th pick is the aging slot; `picks` counts the seat's picks so far. */
export const agingTurn = (picks: number, every: number): boolean => picks % every === every - 1

/**
 * CC-928: the rows ready a day or more as of `today`, longest-ready first, ties by task id. The walk
 * offers the slot to them in this order and takes the first the dispatch checks accept, so no copy
 * of those checks lives here.
 */
export function agedFirst<T extends { id: string }>(
  ready: readonly T[],
  readyDay: (row: T) => number | undefined,
  today: number,
): T[] {
  const day = (row: T): number => readyDay(row) ?? today
  const byAge = (a: T, b: T): number => day(a) - day(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  return ready.filter(row => today - day(row) >= 1).sort(byAge)
}

/** The day the task's `brief:ready` tag names, on `localDay`'s scale. */
export function briefReadyDay(task: ReadyTask): number | undefined {
  const day = parseTaskTags({ id: task.id, tags: task.tags }).task.briefReady
  return day === undefined ? undefined : parseIsoDay(day)
}

/**
 * CC-935: the rows an `on` brief gate takes as ready, in `readyOrder`'s order: the task is in the seat's
 * scope and carries a `brief:ready` no older than `check.maxAgeDays`. The tick and `seats boot` share it.
 */
export function readySet<T extends ReadyOrderRow & { initiative: string }>(
  rows: readonly T[],
  taskOf: (row: T) => ReadyTask | undefined,
  check: BriefCheck,
  scope?: SeatScope,
): T[] {
  const ready = (row: T): boolean => {
    const task = taskOf(row)
    if (task === undefined || scopeRefusal(scope, row.initiative, task) !== undefined) return false
    return briefRefusal(task, check) === undefined
  }
  return readyOrder(rows.filter(ready), row => taskOf(row)?.priority)
}
