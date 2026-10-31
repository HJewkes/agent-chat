import type { Autonomy } from '../active-work.js'
import type { Hold } from './backoff.js'
import type { GateReading } from './gate-reading.js'
import { declaredOps, HUMAN_OPS, isHumanStep, opsLint, opsNoneTag, publishOnlyProblem } from './ops.js'
import type { Blocker } from './refusal-snapshot.js'
import { parseIsoDay, wantsBrief } from './score.js'
import { parseTaskTags } from './task-tags.js'

/**
 * Which task an opted-in initiative would hand to an unattended agent next.
 *
 * Pure over what `source.ts` read off disk. A task is eligible only when it
 * says how it ends (`done_when`), how big it is (`estimate`), carries no tag
 * that reserves it for a person, is not already claimed, and declares no op a
 * person must do or the initiative holds no grant for. A done_when whose prose
 * names such an op without a tag resolving it is refused until the brief does.
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
  /** Free text a triager left on the task (CC-1112); read only by the off-plan check. */
  notes?: string
  tags: string[]
}

export type RefusalKind =
  | 'not-open'
  | 'no-done-when'
  | 'no-estimate'
  | 'reserved-tag'
  | 'claimed'
  | 'needs-grant'
  | 'needs-human'
  | 'human-step'
  | 'ops-unresolved'
  | 'lanes-full'
  | 'no-account'
  | 'budget'
  | 'trust'
  | 'orphan'
  | 'slots'
  | 'worktrees'
  | 'landed'
  | 'open-pr'
  | 'broker-view-unavailable'
  | 'file-overlap'
  | 'contract-overlap'
  | 'untriaged'
  | 'stop-short'
  | 'no-repo'
  | 'role-cap'
  | 'backoff'
  | 'plan-blocked'
  | 'stop-line'
  | 'review-backpressure'
  | 'out-of-scope'
  | 'no-brief'
  | 'off-plan'
  | 'brief-stale'
  | 'blocked'
  | 'repo-ambiguous'

export interface Refusal {
  initiative: string
  task?: string
  kind: RefusalKind
  reason: string
  /** CC-945: the task's own tags, set on an `out-of-scope` refusal so the log can name the tag that failed. */
  tags?: readonly string[]
  /** CC-1097: the lever behind a refusal `blocker()` made, with its figures when it is a capacity cap. */
  gate?: GateReading
  /** CC-1241: the slice letter of a refused ready slice. */
  slice?: string
  /** CC-1241: the task or PR the refusal waits on, for the refusal snapshot. */
  blocker?: Blocker
}

export const RESERVED_TAGS = ['human-only', 'blocked', 'needs-decision']
/** A draft is stored as status open plus this tag, so status alone cannot keep it from dispatch. */
const DRAFT_TAG = 'draft'

/**
 * CC-1121: a queued slice waits on whatever holds its parent task's row: a missing or closed parent, the
 * `blocked` tag, or any reserved or seat-excluded tag. Ready slices skip the scorer, so this is their only gate.
 */
export function sliceRefusal(
  task: Task | undefined,
  excludedTags: readonly string[],
): Pick<Refusal, 'kind' | 'reason'> | undefined {
  if (task === undefined) return { kind: 'not-open', reason: 'its task is missing; its queued slices wait' }
  if (task.status !== 'open')
    return { kind: 'not-open', reason: `status is ${task.status ?? 'missing'}; its queued slices wait` }
  if (task.tags.includes('blocked'))
    return { kind: 'blocked', reason: `${task.id} carries the blocked tag; its queued slices wait` }
  const holding = new Set([...RESERVED_TAGS, ...excludedTags])
  const held = task.tags.filter(tag => holding.has(tag))
  if (held.length > 0)
    return { kind: 'reserved-tag', reason: `tagged ${held.join(', ')}; its queued slices wait` }
  return undefined
}

const MERGE_GRANT = { grant: 'merge-on-green-approve', pattern: /\bmerg(e|ed|es|ing)\b/i }
const RELEASE_GRANT = 'release-through-ci'

type Gap = { kind: RefusalKind; reason: string }

/** A declared human op, or an op the release grant must unlock; the merge grant is still read off prose. */
function declaredGap(tags: readonly string[], doneWhen: string, grants: string[]): Gap | undefined {
  const declared = declaredOps(tags)
  const human = declared.filter(op => HUMAN_OPS.includes(op))
  if (human.length > 0)
    return { kind: 'needs-human', reason: `declares ${human.map(op => `ops:${op}`).join(', ')}` }
  const mixed = declared.includes('publish') ? publishOnlyProblem(doneWhen) : undefined
  if (mixed !== undefined)
    return {
      kind: 'ops-unresolved',
      reason: `ops:publish task is not publish-only (${mixed}); split the build and consumer work into tasks with dep: on a task whose done_when is 'publish <package> at <version>'`,
    }
  const missing = [
    ...(declared.includes('publish') ? [RELEASE_GRANT] : []),
    ...(MERGE_GRANT.pattern.test(doneWhen) ? [MERGE_GRANT.grant] : []),
  ].filter(grant => !grants.includes(grant))
  if (missing.length === 0) return undefined
  return { kind: 'needs-grant', reason: `needs grant ${missing.join(', ')}, which the brief does not hold` }
}

/**
 * CC-974: why `task` cannot be dispatched under `grants`, judged on the ops it declares. Prose
 * never decides: a pattern hit the tags leave unresolved is a brief problem with its fix named.
 */
export function opsGap(task: Pick<Task, 'doneWhen' | 'tags'>, grants: string[]): Gap | undefined {
  const doneWhen = task.doneWhen ?? ''
  if (isHumanStep(task.tags)) {
    const queue = task.tags.includes('kind:owner') ? 'owner' : 'operator'
    return { kind: 'human-step', reason: `routed to the ${queue}, never dispatched` }
  }
  const declared = declaredGap(task.tags, doneWhen, grants)
  if (declared !== undefined) return declared
  const hits = opsLint(doneWhen, task.tags)
  if (hits.length === 0) return undefined
  const named = hits.map(hit => `${hit.op} ('${hit.text}')`).join(', ')
  return {
    kind: 'ops-unresolved',
    reason: `done_when mentions ${named}; split the step out or tag ${opsNoneTag(doneWhen)}`,
  }
}

/** CC-925: a seat's brief gate. `shadow` refuses nothing; the caller notes what `on` would refuse. */
export const BRIEF_GATES = ['off', 'shadow', 'on'] as const
export type BriefGateMode = (typeof BRIEF_GATES)[number]

export interface BriefCheck {
  maxAgeDays: number
  now: Date
}

/** The local calendar day of `now`, on `parseIsoDay`'s scale, as the tick's `today` is local. */
export const localDay = (now: Date): number =>
  Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000

/** Why `task`'s brief is missing or stale, whatever the gate; undefined when it carries a fresh `brief:ready`. */
export function briefRefusal(
  task: { id: string; tags: readonly string[] },
  check: BriefCheck,
): { kind: RefusalKind; reason: string } | undefined {
  const { briefReady } = parseTaskTags({ id: task.id, tags: task.tags }).task
  if (briefReady === undefined) return { kind: 'no-brief', reason: 'no valid brief:ready=<YYYY-MM-DD> tag' }
  const age = localDay(check.now) - (parseIsoDay(briefReady) ?? Number.NaN)
  if (age <= check.maxAgeDays) return undefined
  return {
    kind: 'brief-stale',
    reason: `brief:ready=${briefReady} is ${age} days old; briefMaxAgeDays is ${check.maxAgeDays}`,
  }
}

/** The first reason `task` is ineligible, or undefined when it may be dispatched. */
export function taskRefusal(
  task: Task,
  grants: string[],
  claimed: ReadonlySet<string>,
  held: ReadonlyMap<string, Hold> = new Map(),
  brief?: BriefCheck & { gate: BriefGateMode },
): { kind: RefusalKind; reason: string } | undefined {
  if (task.status !== 'open') return { kind: 'not-open', reason: `status is ${task.status ?? 'missing'}` }
  if (task.doneWhen === undefined)
    return { kind: 'no-done-when', reason: 'no done_when, so no return contract' }
  const wanted = isBriefer(task)
  if (task.estimate === undefined && !wanted) return { kind: 'no-estimate', reason: 'no estimate (CC-137)' }
  const reserved = task.tags.filter(tag => RESERVED_TAGS.includes(tag) || tag === DRAFT_TAG)
  if (reserved.length > 0) return { kind: 'reserved-tag', reason: `tagged ${reserved.join(', ')}` }
  if (claimed.has(task.id)) return { kind: 'claimed', reason: 'held in the burndown claim ledger' }
  const hold = held.get(task.id)
  if (hold !== undefined)
    return { kind: 'backoff', reason: `released ${hold.n} times; held until ${hold.until.toISOString()}` }
  const gap = opsGap(task, grants)
  if (gap !== undefined) return gap
  return brief?.gate === 'on' && !wanted ? briefRefusal(task, brief) : undefined
}

const byPriorityThenSize = (a: Task, b: Task): number =>
  (a.priority ?? Infinity) - (b.priority ?? Infinity) || (a.estimate ?? Infinity) - (b.estimate ?? Infinity)

/** Open tasks only: a closed task is not a refusal anyone needs to read. */
export function pickTask(
  initiative: Initiative & { autonomy: Autonomy },
  tasks: Task[],
  claimed: ReadonlySet<string>,
  held: ReadonlyMap<string, Hold> = new Map(),
): { task?: Task; refusals: Refusal[] } {
  const refusals: Refusal[] = []
  const eligible: Task[] = []
  for (const task of tasks.filter(t => t.status === 'open')) {
    const refusal = taskRefusal(task, initiative.autonomy.grants, claimed, held)
    if (refusal === undefined) eligible.push(task)
    else refusals.push({ initiative: initiative.slug, task: task.id, ...refusal })
  }
  const [task] = eligible.sort(byPriorityThenSize)
  return task === undefined ? { refusals } : { task, refusals }
}

export const PLANNER_PROFILE = 'bd-planner'
export const IMPLEMENTER_PROFILE = 'bd-implementer'

/** CC-939: the one place a task's role is decided: a `brief:wanted` task with a done_when gets a briefer, not a planner. */
export const isBriefer = (task: Pick<Task, 'doneWhen' | 'tags'>): boolean =>
  task.doneWhen !== undefined && wantsBrief(task.tags)

/** Owner decision 186: big work plans first, small work goes to sonnet unless it is a feature, which gets opus. */
export function profileFor(task: Task): string {
  if (isBriefer(task)) return PLANNER_PROFILE
  const estimate = task.estimate ?? Infinity
  if (estimate >= 3) return PLANNER_PROFILE
  return task.tags.includes('kind:feature') ? IMPLEMENTER_PROFILE : 'bd-implementer-lite'
}

/** Profiles that run on sonnet, which is all the tick may use above 85% `seven_day`. */
export const SONNET_PROFILES = new Set(['implementer-lite', 'bd-implementer-lite'])

export const byRank = (a: Initiative, b: Initiative): number =>
  (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.slug.localeCompare(b.slug)
