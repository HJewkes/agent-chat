import path from 'node:path'
import type { PathList, Prior, PriorRule, Profile, WorkflowTable } from './workflow-table.js'

/**
 * CC-637: the task-time prior (shape plan 1.5) and the implementer profile the workflow table gives it.
 * Pure: the same facts give the same prior and reason. Rules run in the table's order and the first match wins,
 * so a risk row (paths, tags) beats a size row however small the estimate.
 */

export interface TaskFacts {
  estimate?: number | null
  done_when?: string | null
  tags?: readonly string[] | null
  /** The union of the plan's slice `owns`, repo-relative; empty without a plan. */
  owns: readonly string[]
}

export interface Classified {
  prior: Prior
  reason: string
}

const TEST_PATH = /(^|\/)(__tests__|__fixtures__|golden|__snapshots__|screenshots)\/|\.(test|spec)\.[^/]+$/
const IGNORED_PATH =
  /(^|\/)\.changeset\/|\.mdx?$|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$|(^|\/)CHANGELOG[^/]*$/i
const UNIT = /^((?:packages|products|apps|plugins)\/[^/]+|src\/[^/]+(?=\/))/

const counts = (file: string) => !TEST_PATH.test(file) && !IGNORED_PATH.test(file)

/** The distinct units (1.2's D) the paths touch; test and ignored paths, and paths outside a unit, count for none. */
export function unitsOf(owns: readonly string[]): string[] {
  const units = owns.filter(counts).flatMap(file => UNIT.exec(file)?.[1] ?? [])
  return [...new Set(units)]
}

/** A directory entry such as `src/broker/` matches a glob for the files under it. */
const matches = (file: string, glob: string) =>
  path.posix.matchesGlob(file, glob) || (file.endsWith('/') && path.posix.matchesGlob(`${file}x`, glob))

const inList = (file: string, globs: readonly string[]) => globs.some(glob => matches(file, glob))

function signal(rule: PriorRule, facts: TaskFacts, paths: Record<PathList, string[]>): string | undefined {
  const tags = facts.tags ?? []
  const owned =
    rule.owns === undefined ? undefined : facts.owns.find(file => inList(file, paths[rule.owns as PathList]))
  if (owned !== undefined) return `owns ${owned} matches ${rule.owns}`
  const only = rule.ownsOnly as PathList | undefined
  if (only !== undefined && facts.owns.length > 0 && facts.owns.every(file => inList(file, paths[only])))
    return `owns only ${only}`
  const units = unitsOf(facts.owns)
  if (rule.unitsAtLeast !== undefined && units.length >= rule.unitsAtLeast)
    return `owns spans ${units.join(', ')}`
  const tag = rule.tags?.find(t => tags.includes(t))
  return tag === undefined ? undefined : `tag ${tag}`
}

const hasSignal = (rule: PriorRule) =>
  rule.owns !== undefined ||
  rule.ownsOnly !== undefined ||
  rule.unitsAtLeast !== undefined ||
  rule.tags !== undefined

function sizeHolds(rule: PriorRule, facts: TaskFacts): boolean {
  const estimate = facts.estimate ?? undefined
  if (rule.estimateAtMost !== undefined && (estimate === undefined || estimate > rule.estimateAtMost))
    return false
  return rule.needsDoneWhen !== true || Boolean(facts.done_when)
}

function ruleMatch(rule: PriorRule, facts: TaskFacts, paths: Record<PathList, string[]>): string | undefined {
  if (!sizeHolds(rule, facts)) return undefined
  const why = signal(rule, facts, paths)
  if (hasSignal(rule)) return why
  return rule.estimateAtMost === undefined
    ? 'fallback'
    : `estimate ${facts.estimate} <= ${rule.estimateAtMost}`
}

export function classifyTask(table: WorkflowTable, facts: TaskFacts): Classified {
  for (const rule of table.priors) {
    const reason = ruleMatch(rule, facts, table.paths)
    if (reason !== undefined) return { prior: rule.prior, reason }
  }
  throw new Error('workflow table has no fallback prior; parseWorkflowTable refuses such a table')
}

/** The profile the prior's class row dispatches at this estimate; an unknown estimate takes the larger rung. */
export function profileFor(table: WorkflowTable, prior: Prior, estimate: number | null | undefined): Profile {
  const target = table.priorWorkflow[prior]
  if (target === 'planner') return 'bd-planner'
  const { implementer, implementerAbove2 } = table.workflow[target]
  const small = estimate !== null && estimate !== undefined && estimate <= 2
  return small ? implementer : (implementerAbove2 ?? implementer)
}
