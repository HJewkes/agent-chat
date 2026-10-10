import { briefRefusal, localDay, type BriefCheck } from './eligibility.js'
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

/** CC-928: one pick in every `every` goes to the longest-ready row; `picks` is the seat's picks so far. */
export interface AgingSlot<T = { id: string }> {
  every: number
  picks: number
  /** Whether the row could go out, so a claimed or backed-off task never spends the slot; absent, all can. */
  dispatchable?: (row: T) => boolean
}

/**
 * The aging slot's reorder: position `i` is the aging slot when `picks + i` is the last of a window of
 * `every`, and takes the row whose `brief:ready` day is oldest (ties by task id) among those ready a
 * day or more that could be dispatched; the rest keep their order. With no aged row the order is unchanged.
 */
export function withAgingSlot<T extends { id: string }>(
  ordered: readonly T[],
  readyDay: (row: T) => number | undefined,
  today: number,
  slot: AgingSlot<T>,
): T[] {
  const day = (row: T): number => readyDay(row) ?? today
  const byAge = (a: T, b: T): number => day(a) - day(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const canGo = slot.dispatchable ?? (() => true)
  const aged = ordered.filter(row => today - day(row) >= 1 && canGo(row)).sort(byAge)
  const remaining = [...ordered]
  const out: T[] = []
  while (remaining.length > 0) {
    const turn = (slot.picks + out.length) % slot.every === slot.every - 1
    const next = (turn ? aged.find(row => remaining.includes(row)) : undefined) ?? remaining[0]!
    remaining.splice(remaining.indexOf(next), 1)
    out.push(next)
  }
  return out
}

/**
 * CC-935: the rows an `on` brief gate takes as ready, in `readyOrder`'s order: the task is in the seat's
 * scope and carries a `brief:ready` no older than `check.maxAgeDays`. The tick and `seats boot` share it;
 * only the tick passes `aging`, since `seats boot` shows the order and spends no pick.
 */
export function readySet<T extends ReadyOrderRow & { initiative: string }>(
  rows: readonly T[],
  taskOf: (row: T) => ReadyTask | undefined,
  check: BriefCheck,
  scope?: SeatScope,
  aging?: AgingSlot<T>,
): T[] {
  const ready = (row: T): boolean => {
    const task = taskOf(row)
    if (task === undefined || scopeRefusal(scope, row.initiative, task) !== undefined) return false
    return briefRefusal(task, check) === undefined
  }
  const ordered = readyOrder(rows.filter(ready), row => taskOf(row)?.priority)
  if (aging === undefined) return ordered
  const readyDay = (row: T): number | undefined => {
    const day = parseTaskTags({ id: row.id, tags: taskOf(row)?.tags ?? [] }).task.briefReady
    return day === undefined ? undefined : parseIsoDay(day)
  }
  return withAgingSlot(ordered, readyDay, localDay(check.now), aging)
}
