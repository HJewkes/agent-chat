import fs from 'node:fs'
import path from 'node:path'
import { parseMilestoneFile, type MilestoneFile, type MilestoneResult } from './milestones.js'
import { planOrder, type PlannedRow } from './plan-order.js'
import { describeUnnamedCriterion, unnamedCriteria } from './ms-role.js'
import { parsePlanningTasks, type TagError } from './task-tags.js'
import { readInitiatives } from './source.js'
import { dormantInitiatives, loadPolicy, seatScope, type Policy } from './policy.js'
import { readScoredTasks } from './score-source.js'
import { planPathFor } from './brief.js'
import { readSlices } from './report.js'
import { classifyTask, profileFor } from './classify-task.js'
import { sharedDefaults, type ProjectShares } from './project-shares.js'
import { readWorkflowTable, type Prior, type Profile, type WorkflowTable } from './workflow-table.js'
import { readySet, type ReadyTask } from './ready-order.js'
import { briefRefusal, type BriefCheck, type RefusalKind } from './eligibility.js'
import { scopeRefusal, type SeatScope } from './seat-scope.js'
import {
  checkToday,
  scoreAll,
  type Components,
  type Exclusions,
  type ScoredTask,
  type ScoringDefaults,
} from './score.js'

/**
 * CC-230: `burndown plan --seat --scored`, the seat's scored dispatch order with every component. CLI-only.
 * CC-628: the order is `planOrder`'s, over this week's milestone file when the autonomy root has one.
 */

/** CC-637: a row with the workflow table's prior and profile, set only when a table is installed and passes its lint. */
export interface ScoredRow extends PlannedRow {
  prior?: Prior
  profile?: Profile
  /** CC-988: under an `on` brief gate, `ready` or the kind the gate refuses the row with. */
  gate?: 'ready' | RefusalKind
}

export interface ScoredPlan {
  order: ScoredRow[]
  /** Initiatives in the seat's scope. */
  scope: number
  /** Open tasks read across that scope, excluded ones included. */
  open: number
  /** Exclusions from scoring, then share-cap skips from the dispatch order. */
  refused: Record<string, number>
  /** `<slug>/<file>` of each malformed open task the reader left out, so a low count from skips is not a real drop. */
  skipped: string[]
  /** The milestone file's week and its validation errors; `absent` when the week has no file (CC-625). */
  milestones?: { week: string; errors: string[]; absent?: true }
  /** CC-631: planning-tag errors such as a typo'd `dep:`, which the order otherwise reads as closed. */
  tagErrors?: string[]
  /** CC-720: one line per open `ms-role:criterion` task that no check of its milestone names; set only when milestones were read. */
  unnamedCriteria?: string[]
  /** CC-769: `<id> <reason>` for each milestone epic `planOrder` held out of tier 2. */
  epicsHeld?: string[]
  /** CC-644: self edges, missing deps, cycles and dependents of a failed upstream, with the task ids named. */
  edgeLines?: string[]
  /** CC-637: the workflow table's lint problems; the rows then carry no prior. */
  workflowTable?: string[]
  /** CC-988: set when `order` is the order an `on` brief gate walks (`gateOrdered`). */
  briefGate?: 'on'
}

export interface ScoredPlanInputs {
  tasks: readonly ScoredTask[]
  weights: Readonly<Record<string, number>>
  defaults: ScoringDefaults
  exclusions: Exclusions
  hardStops: readonly string[]
  today: string
  top: number
  /** Initiatives whose work waits on a gate, so they earn no `gate_free_bonus`. */
  dormant?: ReadonlySet<string>
  skipped?: readonly string[]
  seat?: string
  milestones?: MilestoneFile
  /** Task ids outside `tasks` that a `dep:` may name; without them every closed dep is `unknown-dep`. */
  knownIds?: readonly string[]
  /** CC-644: task id to why it failed; its dependents are blocked. */
  failedUpstreams?: Readonly<Record<string, string>>
}

export function scoredPlan(input: ScoredPlanInputs): ScoredPlan {
  const { tasks, weights, defaults, exclusions, hardStops, today, top, skipped = [] } = input
  const scored = scoreAll(tasks, weights, defaults, exclusions, hardStops, today, input.dormant)
  const planned = planOrder({
    rows: scored.rows,
    tasks,
    defaults,
    n: top,
    today,
    ...(input.seat !== undefined && { seat: input.seat }),
    ...(input.milestones !== undefined && { milestones: input.milestones }),
    ...(input.knownIds !== undefined && { knownIds: input.knownIds }),
    ...(input.failedUpstreams !== undefined && { failedUpstreams: input.failedUpstreams }),
  })
  const unnamed = unnamedCriterionLines(input)
  return {
    order: planned.order,
    scope: Object.keys(weights).length,
    open: tasks.length,
    refused: { ...scored.refused, ...planned.refused },
    skipped: [...skipped],
    tagErrors: planned.tagErrors.map(describeTagError),
    ...(unnamed.length > 0 && { unnamedCriteria: unnamed }),
    ...(planned.epicsHeld.length > 0 && { epicsHeld: planned.epicsHeld }),
    ...(planned.edgeLines.length > 0 && { edgeLines: planned.edgeLines }),
  }
}

function unnamedCriterionLines({ tasks, milestones, knownIds }: ScoredPlanInputs): string[] {
  if (milestones === undefined) return []
  const tagged = parsePlanningTasks(tasks, knownIds).tasks
  return unnamedCriteria(tagged, milestones.milestones).map(describeUnnamedCriterion)
}

const describeTagError = ({ code, task, tag }: TagError) => `${code} ${task} ${tag}`

const DAY_MS = 86_400_000

/** The ISO 8601 week of an ISO day, as `YYYY-Www`, numbered in the year its Thursday falls in. */
export function isoWeek(today: string): string {
  const day = checkToday(today)
  const sinceMonday = (day + 3) % 7
  const thursday = day - sinceMonday + 3
  const year = new Date(thursday * DAY_MS).getUTCFullYear()
  const week = Math.floor((thursday - Date.UTC(year, 0, 1) / DAY_MS) / 7) + 1
  return `${year}-W${String(week).padStart(2, '0')}`
}

/** `<autonomyRoot>/milestones/<week>.yml` for today's ISO week, parsed; undefined when the file is absent. */
export function readWeekMilestones(
  autonomyRoot: string,
  today: string,
  taskIds: Iterable<string>,
): (MilestoneResult & { week: string }) | undefined {
  const week = isoWeek(today)
  const file = path.join(autonomyRoot, 'milestones', `${week}.yml`)
  if (!fs.existsSync(file)) return undefined
  return { week, ...parseMilestoneFile(fs.readFileSync(file, 'utf8'), taskIds) }
}

export const describeError = ({ code, milestone, id, message }: MilestoneResult['errors'][number]) =>
  [code, milestone, id, message].filter(part => part !== undefined).join(' ')

const listDir = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/** Every task id under `<root>/<slug>/tasks`, archived ones included, from the `<id>.yml` file names. */
export function taskIdsOnDisk(root: string): string[] {
  return listDir(root).flatMap(slug =>
    [path.join(root, slug, 'tasks'), path.join(root, slug, 'tasks', 'archive')].flatMap(dir =>
      listDir(dir)
        .filter(file => file.endsWith('.yml'))
        .map(file => file.slice(0, -'.yml'.length)),
    ),
  )
}

export interface ScoredPlanDiskOptions {
  seat: string
  top: number
  today: string
  autonomyRoot: string
  activeWorkRoot: string
  /** CC-935: order as an `on` brief gate does (CC-926), with no share caps or initiative decay. */
  readySet?: boolean
  /** CC-1107: order under project shares' scoring defaults (decay 1, default K, kind caps from `kinds`). */
  shares?: ProjectShares
}

/** Reads the seat's policy from `autonomyRoot` and its scope's open tasks from the active-work root. */
export function scoredPlanFromDisk(opts: ScoredPlanDiskOptions): ScoredPlan {
  return scoredSeatFromDisk(opts).plan
}

/** `scoredPlanFromDisk` with the open tasks it scored, whose tags and priority the rows do not carry. */
export function scoredSeatFromDisk(opts: ScoredPlanDiskOptions): {
  plan: ScoredPlan
  tasks: ScoredTask[]
  policy: Policy
} {
  const policy = loadPolicy(opts.autonomyRoot, opts.seat)
  const weights = seatScope(policy.charter, policy.seats, opts.seat, readInitiatives(opts.activeWorkRoot))
  const { tasks, skipped } = readScoredTasks(opts.activeWorkRoot, Object.keys(weights))
  const knownIds = taskIdsOnDisk(opts.activeWorkRoot)
  const read = readWeekMilestones(opts.autonomyRoot, opts.today, knownIds)
  const plan = scoredPlan({
    tasks,
    skipped,
    seat: opts.seat,
    ...(read?.file !== undefined && { milestones: read.file }),
    weights,
    defaults: diskDefaults(policy.defaults, opts),
    exclusions: { tags: policy.seat.excluded_tags, titlePatterns: policy.seat.excluded_title_patterns },
    hardStops: policy.hardStops,
    today: opts.today,
    top: opts.top,
    dormant: dormantInitiatives(policy.seat),
    knownIds,
  })
  const milestones =
    read === undefined
      ? { week: isoWeek(opts.today), errors: [], absent: true as const }
      : { week: read.week, errors: read.errors.map(describeError) }
  const withWeek = { ...plan, milestones }
  return { plan: withPriors(withWeek, tasks, opts), tasks, policy }
}

/** CC-988: what an `on` brief gate checks a row against: the brief's age, the clock and the seat's scope. */
export interface ScoredGate extends BriefCheck {
  scope?: SeatScope
}

/**
 * CC-988: `plan` in the order the tick walks under an `on` brief gate (CC-926), each row marked: brief-ready rows
 * first in `readySet`'s order, then the rest in base order. `plan` should be read with `readySet: true`.
 */
export function gateOrdered(plan: ScoredPlan, tasks: readonly ScoredTask[], gate: ScoredGate): ScoredPlan {
  const byKey = new Map(tasks.map(task => [`${task.slug}/${task.id}`, { ...task, tags: task.tags ?? [] }]))
  const taskOf = (row: ScoredRow) => byKey.get(`${row.initiative}/${row.id}`)
  const ready = readySet(plan.order, taskOf, gate, gate.scope)
  const taken = new Set(ready)
  const refused = plan.order
    .filter(row => !taken.has(row))
    .map(row => ({ ...row, gate: gateRefusal(row, taskOf(row), gate) }))
  const order = [...ready.map(row => ({ ...row, gate: 'ready' as const })), ...refused]
  return { ...plan, order, briefGate: 'on' }
}

function gateRefusal(row: ScoredRow, task: ReadyTask | undefined, gate: ScoredGate): RefusalKind {
  if (task === undefined) return 'no-brief'
  if (scopeRefusal(gate.scope, row.initiative, task) !== undefined) return 'out-of-scope'
  return briefRefusal(task, gate)?.kind ?? 'no-brief'
}

function diskDefaults(defaults: ScoringDefaults, opts: ScoredPlanDiskOptions): ScoringDefaults {
  if (opts.shares !== undefined) return sharedDefaults(defaults, opts.shares)
  return opts.readySet === true ? { ...defaults, share_caps: {}, initiative_decay: 1 } : defaults
}

function withPriors(plan: ScoredPlan, tasks: readonly ScoredTask[], opts: ScoredPlanDiskOptions): ScoredPlan {
  const read = readWorkflowTable(opts.autonomyRoot)
  if (read === undefined) return plan
  if (read.table === undefined) return { ...plan, workflowTable: read.problems }
  const byId = new Map(tasks.map(task => [task.id, task]))
  const order = plan.order.map(row => {
    const task = byId.get(row.id)
    return task === undefined ? row : { ...row, ...priorOf(read.table, task, opts.activeWorkRoot) }
  })
  return { ...plan, order }
}

function priorOf(
  table: WorkflowTable,
  task: ScoredTask,
  activeWorkRoot: string,
): { prior: Prior; profile: Profile } {
  const owns = ownsOf(planPathFor(path.join(activeWorkRoot, task.slug), task.id))
  const { prior } = classifyTask(table, { ...task, owns })
  return { prior, profile: profileFor(table, prior, task.estimate) }
}

/** The union of the plan's slice owns; empty with no plan or one that fails the slice lint. */
function ownsOf(planFile: string): string[] {
  if (!fs.existsSync(planFile)) return []
  const slices = readSlices(fs.readFileSync(planFile, 'utf8')).slices ?? []
  return [...new Set(slices.flatMap(slice => slice.owns))]
}

const COMPONENT_KEYS: Exclude<keyof Components, 'G'>[] = ['S', 'P', 'U', 'A', 'W', 'K', 'R', 'Z', 'H']
const TITLE_WIDTH = 90

const fixed = (x: number, width: number) => x.toFixed(1).padStart(width)
const optional = (x: number | undefined, digits: number) => (x === undefined ? '-' : x.toFixed(digits))

/** The first columns follow score.py's text output so the two diff by eye; components, then the plan's tier, float and WSJF follow. */
export function renderScoredRow(row: ScoredRow, rank: number): string {
  const prior = row.prior === undefined ? '' : ` prior=${row.prior} profile=${row.profile}`
  const plan = `tier=${row.tier} float=${optional(row.float, 1)} wsjf=${optional(row.wsjf, 2)}`
  const components = COMPONENT_KEYS.map(k => `${k}=${row.components[k].toFixed(2)}`).join(' ')
  const flags = row.stopShort.length > 0 ? ` stop-short:${row.stopShort.join(',')}` : ''
  const gate = row.gate === undefined ? '' : ` gate=${row.gate}`
  return (
    `${String(rank).padStart(2)} ${fixed(row.effective, 5)} (${fixed(row.score, 5)}) ` +
    `${row.id.padEnd(9)} ${row.initiative.slice(0, 16).padEnd(16)} ${row.kind}/${row.kindSource}  ` +
    `${components} est=${row.estimate ?? '-'} route=${row.route}${prior} ${plan}${flags}${gate} | ${row.title.slice(0, TITLE_WIDTH)}`
  )
}

function milestoneLine({ week, errors, absent }: NonNullable<ScoredPlan['milestones']>): string {
  if (absent) return `milestones=${week} absent: no milestones/${week}.yml, order by tags alone`
  return `milestones=${week}, errors: ${errors.join('; ') || 'none'}`
}

export const GATE_HEADER =
  'order: brief gate on, no decay or share caps, brief-ready first by priority (as the tick walks)'

export function renderScored(plan: ScoredPlan): string[] {
  const refused = Object.entries(plan.refused)
    .map(([kind, n]) => `${kind}: ${n}`)
    .join(', ')
  const milestones = plan.milestones ? [milestoneLine(plan.milestones)] : []
  const table = plan.workflowTable ? [`workflow table: ${plan.workflowTable.join('; ')}`] : []
  const tagErrors = plan.tagErrors?.length ? [`task tags errors: ${plan.tagErrors.join('; ')}`] : []
  const epics = plan.epicsHeld?.length ? [`epics held out of tier 2: ${plan.epicsHeld.join('; ')}`] : []
  return [
    ...(plan.briefGate === 'on' ? [GATE_HEADER] : []),
    ...plan.order.map((row, i) => renderScoredRow(row, i + 1)),
    ...milestones,
    ...table,
    ...(plan.edgeLines ?? []),
    ...tagErrors,
    ...epics,
    ...(plan.unnamedCriteria ?? []),
    `scope=${plan.scope} initiatives, ${plan.open} open, skipped: ${plan.skipped.length}, refused={${refused}}`,
  ]
}
