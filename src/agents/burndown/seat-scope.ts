import type { SeatPolicy } from './policy.js'

/**
 * CC-779: which of a seat's scored tasks are its to take. A seat's `scope_tags` narrow the initiatives
 * it shares with another seat, where each seat takes only its lane; an initiative the seat holds alone
 * stays whole. A task the seat's `backlog` file names is in scope whatever its tags. Pure.
 */

export interface SeatScope {
  /** The seat file's `scope_tags`; empty leaves every initiative whole. */
  tags: readonly string[]
  /** The seat's initiatives that another seat's file also lists; only these are narrowed. */
  shared: readonly string[]
  /** Task IDs the backlog file names. */
  backlog: ReadonlySet<string>
  /** The backlog file as the seat file names it, for the refusal. */
  backlogFile?: string
}

const TASK_ID = /\b[A-Z]{1,5}-\d+\b/g

/** Every task ID in the backlog's text, as score.py's `ID` pattern finds them. */
export const backlogIds = (text: string): Set<string> => new Set(text.match(TASK_ID) ?? [])

export function seatScopeOf(
  seats: Readonly<Record<string, SeatPolicy>>,
  name: string,
  backlog: ReadonlySet<string>,
): SeatScope {
  const seat = seats[name]
  if (seat === undefined) throw new Error(`${name} is not a seat`)
  const others = Object.entries(seats).filter(([other]) => other !== name)
  const shared = Object.keys(seat.initiatives).filter(slug => others.some(([, s]) => slug in s.initiatives))
  return {
    tags: seat.scope_tags,
    shared,
    backlog,
    ...(seat.backlog === undefined ? {} : { backlogFile: seat.backlog }),
  }
}

/** Why the task is outside the seat's scope, or undefined when it is the seat's to take. */
export function scopeRefusal(
  scope: SeatScope | undefined,
  initiative: string,
  task: { id: string; tags: readonly string[] },
): string | undefined {
  if (scope === undefined || scope.tags.length === 0 || !scope.shared.includes(initiative)) return undefined
  if (scope.backlog.has(task.id) || task.tags.some(tag => scope.tags.includes(tag))) return undefined
  const named = scope.backlogFile === undefined ? '' : ` and ${scope.backlogFile} does not name it`
  return `${initiative} is shared, the task carries none of scope_tags [${scope.tags.join(', ')}]${named}`
}
