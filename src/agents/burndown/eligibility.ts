import type { Autonomy } from '../active-work.js'

/**
 * Which task an opted-in initiative would hand to an unattended agent next.
 *
 * Pure over what `source.ts` read off disk. A task is eligible only when it
 * says how it ends (`done_when`), how big it is (`estimate`), carries no tag
 * that reserves it for a person, is not already claimed, and does not name an
 * action the initiative holds no grant for. The grant check is a keyword match
 * and deliberately over-matches: a false hit costs a line in the backlog, a
 * miss costs an agent doing something nobody allowed.
 */

export interface Initiative {
  slug: string
  state?: string
  rank?: number
  profile?: string
  autonomy?: Autonomy
}

export interface Task {
  id: string
  title: string
  status?: string
  priority?: number
  estimate?: number
  doneWhen?: string
  tags: string[]
}

export type RefusalKind =
  | 'not-open'
  | 'no-done-when'
  | 'no-estimate'
  | 'reserved-tag'
  | 'claimed'
  | 'needs-grant'
  | 'lanes-full'
  | 'no-account'
  | 'budget'
  | 'trust'

export interface Refusal {
  initiative: string
  task?: string
  kind: RefusalKind
  reason: string
}

export const RESERVED_TAGS = ['human-only', 'blocked', 'needs-decision']

/** Actions a brief grant can unlock for the tick (design section 5). */
const GRANTABLE: { grant: string; pattern: RegExp }[] = [
  { grant: 'merge-on-green-approve', pattern: /\bmerg(e|ed|es|ing)\b/i },
  { grant: 'release-through-ci', pattern: /\b(publish(es|ed|ing)?|tag push|cut a release)\b/i },
]

/** Actions no brief grant unlocks: a person does them, so the task waits for one. */
const HUMAN_ONLY: { action: string; pattern: RegExp }[] = [
  {
    action: 'broker restart',
    pattern: /\brestart(s|ed|ing)? (the )?broker\b|\bbroker restart\b|restart window/i,
  },
  { action: 'deploy', pattern: /\bdeploy(s|ed|ing)?\b|\bwrangler\b|launchd install/i },
  { action: 'force-push or hard reset', pattern: /force-push|reset --hard/i },
  { action: 'config edit', pattern: /CLAUDE\.md|settings\.json|~\/\.agent-chat\//i },
  { action: 'spend money', pattern: /\b(purchase|pay for|spend money)\b/i },
]

/** Why `doneWhen` cannot be reached under `grants`, or undefined when it can. */
export function grantGap(doneWhen: string, grants: string[]): string | undefined {
  const human = HUMAN_ONLY.filter(h => h.pattern.test(doneWhen)).map(h => h.action)
  if (human.length > 0) return `done_when names a human-only action (${human.join(', ')})`
  const missing = GRANTABLE.filter(g => g.pattern.test(doneWhen) && !grants.includes(g.grant))
  if (missing.length === 0) return undefined
  return `done_when needs grant ${missing.map(g => g.grant).join(', ')}, which the brief does not hold`
}

/** The first reason `task` is ineligible, or undefined when it may be dispatched. */
export function taskRefusal(
  task: Task,
  grants: string[],
  claimed: ReadonlySet<string>,
): { kind: RefusalKind; reason: string } | undefined {
  if (task.status !== 'open') return { kind: 'not-open', reason: `status is ${task.status ?? 'missing'}` }
  if (task.doneWhen === undefined)
    return { kind: 'no-done-when', reason: 'no done_when, so no return contract' }
  if (task.estimate === undefined) return { kind: 'no-estimate', reason: 'no estimate (CC-137)' }
  const reserved = task.tags.filter(tag => RESERVED_TAGS.includes(tag))
  if (reserved.length > 0) return { kind: 'reserved-tag', reason: `tagged ${reserved.join(', ')}` }
  if (claimed.has(task.id)) return { kind: 'claimed', reason: 'held in the burndown claim ledger' }
  const gap = grantGap(task.doneWhen, grants)
  return gap === undefined ? undefined : { kind: 'needs-grant', reason: gap }
}

const byPriorityThenSize = (a: Task, b: Task): number =>
  (a.priority ?? Infinity) - (b.priority ?? Infinity) || (a.estimate ?? Infinity) - (b.estimate ?? Infinity)

/** Open tasks only: a closed task is not a refusal anyone needs to read. */
export function pickTask(
  initiative: Initiative & { autonomy: Autonomy },
  tasks: Task[],
  claimed: ReadonlySet<string>,
): { task?: Task; refusals: Refusal[] } {
  const refusals: Refusal[] = []
  const eligible: Task[] = []
  for (const task of tasks.filter(t => t.status === 'open')) {
    const refusal = taskRefusal(task, initiative.autonomy.grants, claimed)
    if (refusal === undefined) eligible.push(task)
    else refusals.push({ initiative: initiative.slug, task: task.id, ...refusal })
  }
  const [task] = eligible.sort(byPriorityThenSize)
  return task === undefined ? { refusals } : { task, refusals }
}

/** The CC-136 split: big work plans first, small work that names its tests goes to the sonnet profile. */
export function profileFor(task: Task): string {
  const estimate = task.estimate ?? Infinity
  if (estimate >= 3) return 'planner'
  if (estimate <= 1 && /\btests?\b/i.test(task.doneWhen ?? '')) return 'implementer-lite'
  return 'implementer'
}

/** Profiles that run on sonnet, which is all the tick may use above 85% `seven_day`. */
export const SONNET_PROFILES = new Set(['implementer-lite'])

export const byRank = (a: Initiative, b: Initiative): number =>
  (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.slug.localeCompare(b.slug)
