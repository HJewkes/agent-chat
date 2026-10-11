import fs from 'node:fs'
import path from 'node:path'
import { parseDocument } from 'yaml'
import { z } from 'zod'

/**
 * CC-637 (PR shape B4): the workflow table as data, `<autonomyRoot>/workflow/shape-v1.yml`, and its lint.
 * Shadow only: `burndown plan --scored` prints the prior and profile it gives; nothing routes by it yet (B6).
 * Every value is a closed enum, so a typo is a lint problem rather than a row that silently matches nothing.
 */

export const TABLE_VERSION = 'shape-v1'

export const CLASSES = [
  'generated',
  'release',
  'one-way',
  'safety-path',
  'ui-round',
  'agent-text',
  'inert',
  'mechanical',
  'local-fix',
  'cross-package',
  'feature-slice',
] as const
export type ShapeClass = (typeof CLASSES)[number]

export const PRIORS = [
  'one-way',
  'safety-path',
  'ui-round',
  'cross-package',
  'agent-text',
  'small',
  'standard',
  'needs-plan',
] as const
export type Prior = (typeof PRIORS)[number]

export const PLAN_LADDER = [
  'none',
  'explore',
  'bd-planner',
  'fable-architect',
  'titan-component-workflow',
] as const
export const IMPLEMENTER_LADDER = [
  'code',
  'bd-implementer-lite',
  'bd-implementer',
  'fable-implementer',
] as const
export const REVIEW_LADDER = [
  'ci',
  'reviewer',
  'bd-reviewer',
  'fable-reviewer',
  'fable-reviewer+owner',
] as const
export const MERGE_LADDER = ['MRG-AU-CI', 'MRG-AU-RV', 'owner', 'release-path'] as const
export const PATH_LISTS = ['door', 'safety', 'visual', 'agentText'] as const

export type Implementer = (typeof IMPLEMENTER_LADDER)[number]
export type Profile = Implementer | 'bd-planner'
export type PathList = (typeof PATH_LISTS)[number]

const closed = <T extends readonly [string, ...string[]]>(values: T, what: string) =>
  z.enum(values, { error: issue => `unknown ${what} ${JSON.stringify(issue.input)}` })

/** The size classes split two rungs by estimate (2.2): the `*Above2` rung, when set, applies past estimate 2. */
const WorkflowRow = z.strictObject({
  plan: closed(PLAN_LADDER, 'plan ladder value'),
  planAbove2: closed(PLAN_LADDER, 'plan ladder value').optional(),
  implementer: closed(IMPLEMENTER_LADDER, 'implementer profile'),
  implementerAbove2: closed(IMPLEMENTER_LADDER, 'implementer profile').optional(),
  review: closed(REVIEW_LADDER, 'review ladder value'),
  merge: closed(MERGE_LADDER, 'merge ladder value'),
})

/** One 1.5 row. A row matches when every size condition holds and, if it names any signal, at least one signal does. */
const PriorRule = z.strictObject({
  prior: closed(PRIORS, 'prior'),
  owns: z.string().optional(),
  ownsOnly: z.string().optional(),
  unitsAtLeast: z.number().int().positive().optional(),
  tags: z.array(z.string().min(1)).optional(),
  estimateAtMost: z.number().optional(),
  needsDoneWhen: z.boolean().optional(),
})

const TableShape = z.strictObject({
  version: z.literal(TABLE_VERSION),
  paths: z.record(z.string(), z.array(z.string().min(1))),
  priors: z.array(PriorRule).min(1),
  workflow: z.record(z.string(), WorkflowRow),
  priorWorkflow: z.record(z.string(), z.string()),
})

export type PriorRule = z.infer<typeof PriorRule>
export type WorkflowRow = z.infer<typeof WorkflowRow>
export type WorkflowTable = Omit<z.infer<typeof TableShape>, 'paths' | 'workflow' | 'priorWorkflow'> & {
  paths: Record<PathList, string[]>
  workflow: Record<ShapeClass, WorkflowRow>
  /** Which class row gives a prior its implementer; `planner` sends it to `bd-planner`. */
  priorWorkflow: Record<Prior, ShapeClass | 'planner'>
}

export type TableRead =
  { table: WorkflowTable; problems?: undefined } | { table?: undefined; problems: string[] }

const isOneOf = <T extends string>(values: readonly T[], value: string): value is T =>
  (values as readonly string[]).includes(value)

const shapeProblem = (issue: z.core.$ZodIssue): string =>
  issue.path.length === 0 ? issue.message : `at ${issue.path.join('.')}: ${issue.message}`

function keyProblems(keys: string[], values: readonly string[], what: string, where: string): string[] {
  return [
    ...keys
      .filter(key => !isOneOf(values, key))
      .map(key => `at ${where}: unknown ${what} ${JSON.stringify(key)}`),
    ...values.filter(value => !keys.includes(value)).map(value => `at ${where}: no row for ${what} ${value}`),
  ]
}

function ruleProblems(priors: readonly PriorRule[]): string[] {
  const named = priors.flatMap((rule, i) =>
    (['owns', 'ownsOnly'] as const).flatMap(key => {
      const list = rule[key]
      return list === undefined || isOneOf(PATH_LISTS, list)
        ? []
        : [`at priors.${i}.${key}: unknown path list ${JSON.stringify(list)}`]
    }),
  )
  const last = priors.at(-1)
  const fallback =
    last !== undefined && Object.keys(last).length === 1 ? [] : ['priors has no fallback row last']
  return [...named, ...fallback]
}

function lintTable(raw: z.infer<typeof TableShape>): string[] {
  const priorTargets = Object.entries(raw.priorWorkflow).flatMap(([prior, target]) =>
    target === 'planner' || isOneOf(CLASSES, target)
      ? []
      : [`at priorWorkflow.${prior}: unknown class ${JSON.stringify(target)}`],
  )
  return [
    ...keyProblems(Object.keys(raw.paths), PATH_LISTS, 'path list', 'paths'),
    ...keyProblems(Object.keys(raw.workflow), CLASSES, 'class', 'workflow'),
    ...keyProblems(Object.keys(raw.priorWorkflow), PRIORS, 'prior', 'priorWorkflow'),
    ...priorTargets,
    ...ruleProblems(raw.priors),
  ]
}

/** The table, or one reason line per problem. Pure; the caller reads the file. */
export function parseWorkflowTable(text: string): TableRead {
  const doc = parseDocument(text)
  if (doc.errors.length > 0) return { problems: doc.errors.map(err => `yaml: ${err.message}`) }
  const parsed = TableShape.safeParse(doc.toJS())
  if (!parsed.success) return { problems: parsed.error.issues.map(shapeProblem) }
  const problems = lintTable(parsed.data)
  return problems.length === 0 ? { table: parsed.data as WorkflowTable } : { problems }
}

export const workflowTablePath = (autonomyRoot: string): string =>
  path.join(autonomyRoot, 'workflow', `${TABLE_VERSION}.yml`)

/** `<autonomyRoot>/workflow/shape-v1.yml`, linted; undefined when the file is absent. */
export function readWorkflowTable(autonomyRoot: string): TableRead | undefined {
  const file = workflowTablePath(autonomyRoot)
  if (!fs.existsSync(file)) return undefined
  return parseWorkflowTable(fs.readFileSync(file, 'utf8'))
}
