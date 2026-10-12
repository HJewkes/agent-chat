import type { SeatPolicy } from './policy.js'

/**
 * CC-779: which of a seat's scored tasks are its to take. A seat's `scope_tags` narrow the initiatives
 * it shares with another seat, where each seat takes only its lane; an initiative the seat holds alone
 * stays whole. A task the seat's `backlog` file names is in scope whatever its tags, and so is one the
 * accepted plan's section 2 names or links to (CC-1128). Pure.
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
  /** Task IDs in section 2 of the seat's `plan_file`; absent when the seat names none or it could not be read. */
  plan?: ReadonlySet<string>
  /** The plan file as the seat file names it. */
  planFile?: string
  /** Tag-family aliases, `{spine: 'milestone'}`: `spine:M3` and `milestone:M3` are one tag. Absent means none. */
  aliases?: Readonly<Record<string, string>>
}

/** The tag with its family prefix replaced by the family it aliases, so both spellings compare equal. */
export function canonicalTag(tag: string, aliases: Readonly<Record<string, string>> | undefined): string {
  const colon = tag.indexOf(':')
  if (aliases === undefined || colon < 0) return tag
  const family = aliases[tag.slice(0, colon)]
  return family === undefined ? tag : `${family}${tag.slice(colon)}`
}

const TASK_ID = /\b[A-Z]{1,5}-\d+\b/g

/** Every task ID in the backlog's text, as score.py's `ID` pattern finds them. */
export const backlogIds = (text: string): Set<string> => new Set(text.match(TASK_ID) ?? [])

/** The task IDs between the first `## 2.` heading and the next `## ` heading, or undefined without one. */
export function planSectionIds(text: string): Set<string> | undefined {
  const lines = text.split('\n')
  const start = lines.findIndex(line => /^## 2[.\s]/.test(line))
  if (start < 0) return undefined
  const after = lines.slice(start + 1)
  const end = after.findIndex(line => line.startsWith('## '))
  return backlogIds((end < 0 ? after : after.slice(0, end)).join('\n'))
}

/** The factory-planner's link prefixes: a task carrying one of these naming a plan id is on plan. */
const PLAN_LINKS = ['dep:', 'parent:', 'delivered-by:', 'blocked-by:']

/** Whether the plan names the task's id, or one of its link tags names a plan id. */
export function onPlan(
  plan: ReadonlySet<string> | undefined,
  task: { id: string; tags: readonly string[] },
): boolean {
  if (plan === undefined || plan.size === 0) return false
  if (plan.has(task.id)) return true
  return task.tags.some(tag =>
    PLAN_LINKS.some(link => tag.startsWith(link) && plan.has(tag.slice(link.length))),
  )
}

export function seatScopeOf(
  seats: Readonly<Record<string, SeatPolicy>>,
  name: string,
  backlog: ReadonlySet<string>,
  aliases?: Readonly<Record<string, string>>,
  plan?: ReadonlySet<string>,
): SeatScope {
  const seat = seats[name]
  if (seat === undefined) throw new Error(`${name} is not a seat`)
  const others = Object.entries(seats).filter(([other]) => other !== name)
  const shared = Object.keys(seat.initiatives).filter(slug => others.some(([, s]) => slug in s.initiatives))
  return {
    tags: seat.scope_tags,
    shared,
    backlog,
    ...(aliases === undefined ? {} : { aliases }),
    ...(seat.backlog === undefined ? {} : { backlogFile: seat.backlog }),
    ...(plan === undefined ? {} : { plan }),
    ...(seat.plan_file === undefined ? {} : { planFile: seat.plan_file }),
  }
}

/** Why the task is outside the seat's scope, or undefined when it is the seat's to take. */
export function scopeRefusal(
  scope: SeatScope | undefined,
  initiative: string,
  task: { id: string; tags: readonly string[] },
): string | undefined {
  if (scope === undefined || scope.tags.length === 0 || !scope.shared.includes(initiative)) return undefined
  if (scope.backlog.has(task.id) || onPlan(scope.plan, task)) return undefined
  const wanted = new Set(scope.tags.map(tag => canonicalTag(tag, scope.aliases)))
  if (task.tags.some(tag => wanted.has(canonicalTag(tag, scope.aliases)))) return undefined
  const named = scope.backlogFile === undefined ? '' : ` and ${scope.backlogFile} does not name it`
  return `${initiative} is shared, the task carries none of scope_tags [${scope.tags.join(', ')}]${named}`
}
