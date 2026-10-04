import { parseIsoDay } from './score.js'

/** CC-626: the planning tags `milestone:`, `epic:`, `dep:`, `cos:` and `due:` on a task, parsed purely. Other tags pass through untouched. */

export const CLASSES_OF_SERVICE = ['expedite', 'fixed', 'standard', 'intangible'] as const
export type ClassOfService = (typeof CLASSES_OF_SERVICE)[number]

/** The fields the parser reads; `ScoredTask` satisfies it. */
export interface PlanTask {
  id: string
  estimate?: number | null
  tags?: readonly string[] | null
}

export interface TaggedTask {
  id: string
  estimate?: number
  milestone?: string
  epic?: string
  /** One per `dep:` tag, deduplicated, in tag order. */
  deps: string[]
  cos: ClassOfService
  /** ISO day, `YYYY-MM-DD`. */
  due?: string
}

export type TagErrorCode =
  'empty-value' | 'unknown-cos' | 'bad-due' | 'fixed-without-due' | 'conflicting-tag' | 'unknown-dep'

export interface TagError {
  code: TagErrorCode
  task: string
  tag: string
}

type SingleKey = 'milestone' | 'epic' | 'cos' | 'due'
type TagKey = SingleKey | 'dep'

const TAG_KEYS: ReadonlySet<string> = new Set<TagKey>(['milestone', 'epic', 'dep', 'cos', 'due'])

function splitTag(tag: string): { key: TagKey; value: string } | undefined {
  const at = tag.indexOf(':')
  const key = tag.slice(0, at)
  if (at < 0 || !TAG_KEYS.has(key)) return undefined
  return { key: key as TagKey, value: tag.slice(at + 1).trim() }
}

const isClassOfService = (value: string): value is ClassOfService =>
  (CLASSES_OF_SERVICE as readonly string[]).includes(value)

function valueError(key: TagKey, value: string): TagErrorCode | undefined {
  if (value === '') return 'empty-value'
  if (key === 'cos' && !isClassOfService(value)) return 'unknown-cos'
  if (key === 'due' && parseIsoDay(value) === undefined) return 'bad-due'
  return undefined
}

interface CollectedTags {
  single: Partial<Record<SingleKey, string>>
  deps: Set<string>
  errors: TagError[]
}

/** A repeated single-valued tag with a new value is `conflicting-tag`; the first value wins. */
function collectTags(task: PlanTask): CollectedTags {
  const collected: CollectedTags = { single: {}, deps: new Set(), errors: [] }
  const { single } = collected
  for (const tag of task.tags ?? []) {
    const parsed = splitTag(tag)
    if (!parsed) continue
    const { key, value } = parsed
    const conflict = key !== 'dep' && single[key] !== undefined && single[key] !== value
    const code = valueError(key, value) ?? (conflict ? 'conflicting-tag' : undefined)
    if (code) collected.errors.push({ code, task: task.id, tag })
    else if (key === 'dep') collected.deps.add(value)
    else single[key] = value
  }
  return collected
}

/** One task's planning tags; `cos` defaults to `standard`, and `cos:fixed` needs a valid `due:`. */
export function parseTaskTags(task: PlanTask): { task: TaggedTask; errors: TagError[] } {
  const { single, deps, errors } = collectTags(task)
  const cos = (single.cos ?? 'standard') as ClassOfService
  const badDue = errors.some(e => e.code === 'bad-due')
  if (cos === 'fixed' && single.due === undefined && !badDue) {
    errors.push({ code: 'fixed-without-due', task: task.id, tag: 'cos:fixed' })
  }
  const { milestone, epic, due } = single
  const optional = {
    ...(typeof task.estimate === 'number' && { estimate: task.estimate }),
    ...(milestone !== undefined && { milestone }),
    ...(epic !== undefined && { epic }),
    ...(due !== undefined && { due }),
  }
  return { task: { id: task.id, ...optional, deps: [...deps], cos }, errors }
}

/**
 * Every task's planning tags, plus `unknown-dep` for a `dep:` naming no known task.
 * `otherIds` names tasks outside `tasks` that a `dep:` may still point at, such as closed ones.
 */
export function parsePlanningTasks(
  tasks: readonly PlanTask[],
  otherIds: Iterable<string> = [],
): { tasks: TaggedTask[]; errors: TagError[] } {
  const known = new Set([...tasks.map(t => t.id), ...otherIds])
  const parsed = tasks.map(parseTaskTags)
  const errors = parsed.flatMap(({ task, errors: tagErrors }) => [
    ...tagErrors,
    ...task.deps
      .filter(dep => !known.has(dep))
      .map(dep => ({ code: 'unknown-dep' as const, task: task.id, tag: `dep:${dep}` })),
  ])
  return { tasks: parsed.map(p => p.task), errors }
}
