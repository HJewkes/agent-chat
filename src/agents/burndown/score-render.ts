import fs from 'node:fs'
import path from 'node:path'
import { parseMilestoneFile, type MilestoneFile, type MilestoneResult } from './milestones.js'
import { planOrder, type PlannedRow } from './plan-order.js'
import type { TagError } from './task-tags.js'
import { readInitiatives } from './source.js'
import { loadPolicy, seatScope } from './policy.js'
import { readScoredTasks } from './score-source.js'
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

export interface ScoredPlan {
  order: PlannedRow[]
  /** Initiatives in the seat's scope. */
  scope: number
  /** Open tasks read across that scope, excluded ones included. */
  open: number
  /** Exclusions from scoring, then share-cap skips from the dispatch order. */
  refused: Record<string, number>
  /** `<slug>/<file>` of each malformed open task the reader left out, so a low count from skips is not a real drop. */
  skipped: string[]
  /** The milestone file's week and its validation errors, when one was read. */
  milestones?: { week: string; errors: string[] }
  /** CC-631: planning-tag errors such as a typo'd `dep:`, which the order otherwise reads as closed. */
  tagErrors?: string[]
}

export interface ScoredPlanInputs {
  tasks: readonly ScoredTask[]
  weights: Readonly<Record<string, number>>
  defaults: ScoringDefaults
  exclusions: Exclusions
  hardStops: readonly string[]
  today: string
  top: number
  skipped?: readonly string[]
  seat?: string
  milestones?: MilestoneFile
  /** Task ids outside `tasks` that a `dep:` may name; without them every closed dep is `unknown-dep`. */
  knownIds?: readonly string[]
}

export function scoredPlan(input: ScoredPlanInputs): ScoredPlan {
  const { tasks, weights, defaults, exclusions, hardStops, today, top, skipped = [] } = input
  const scored = scoreAll(tasks, weights, defaults, exclusions, hardStops, today)
  const planned = planOrder({
    rows: scored.rows,
    tasks,
    defaults,
    n: top,
    today,
    ...(input.seat !== undefined && { seat: input.seat }),
    ...(input.milestones !== undefined && { milestones: input.milestones }),
    ...(input.knownIds !== undefined && { knownIds: input.knownIds }),
  })
  return {
    order: planned.order,
    scope: Object.keys(weights).length,
    open: tasks.length,
    refused: { ...scored.refused, ...planned.refused },
    skipped: [...skipped],
    tagErrors: planned.tagErrors.map(describeTagError),
  }
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

const describeError = ({ code, milestone, id, message }: MilestoneResult['errors'][number]) =>
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

/** Reads the seat's policy from `autonomyRoot` and its scope's open tasks from the active-work root. */
export function scoredPlanFromDisk(opts: {
  seat: string
  top: number
  today: string
  autonomyRoot: string
  activeWorkRoot: string
}): ScoredPlan {
  const policy = loadPolicy(opts.autonomyRoot, opts.seat)
  const weights = seatScope(policy.charter, policy.seats, opts.seat, readInitiatives(opts.activeWorkRoot))
  const { tasks, skipped } = readScoredTasks(opts.activeWorkRoot, Object.keys(weights))
  const read = readWeekMilestones(
    opts.autonomyRoot,
    opts.today,
    tasks.map(task => task.id),
  )
  const plan = scoredPlan({
    tasks,
    skipped,
    seat: opts.seat,
    ...(read?.file !== undefined && { milestones: read.file }),
    weights,
    defaults: policy.defaults,
    exclusions: { tags: policy.seat.excluded_tags, titlePatterns: policy.seat.excluded_title_patterns },
    hardStops: policy.charter.hard_stops,
    today: opts.today,
    top: opts.top,
    knownIds: taskIdsOnDisk(opts.activeWorkRoot),
  })
  return read === undefined
    ? plan
    : { ...plan, milestones: { week: read.week, errors: read.errors.map(describeError) } }
}

const COMPONENT_KEYS: (keyof Components)[] = ['S', 'P', 'U', 'A', 'W', 'K', 'R', 'Z', 'H']
const TITLE_WIDTH = 90

const fixed = (x: number, width: number) => x.toFixed(1).padStart(width)
const optional = (x: number | undefined, digits: number) => (x === undefined ? '-' : x.toFixed(digits))

/** The first columns follow score.py's text output so the two diff by eye; components, then the plan's tier, float and WSJF follow. */
export function renderScoredRow(row: PlannedRow, rank: number): string {
  const plan = `tier=${row.tier} float=${optional(row.float, 1)} wsjf=${optional(row.wsjf, 2)}`
  const components = COMPONENT_KEYS.map(k => `${k}=${row.components[k].toFixed(2)}`).join(' ')
  const flags = row.stopShort.length > 0 ? ` stop-short:${row.stopShort.join(',')}` : ''
  return (
    `${String(rank).padStart(2)} ${fixed(row.effective, 5)} (${fixed(row.score, 5)}) ` +
    `${row.id.padEnd(9)} ${row.initiative.slice(0, 16).padEnd(16)} ${row.kind}/${row.kindSource}  ` +
    `${components} est=${row.estimate ?? '-'} route=${row.route} ${plan}${flags} | ${row.title.slice(0, TITLE_WIDTH)}`
  )
}

export function renderScored(plan: ScoredPlan): string[] {
  const refused = Object.entries(plan.refused)
    .map(([kind, n]) => `${kind}: ${n}`)
    .join(', ')
  const milestones = plan.milestones
    ? [`milestones=${plan.milestones.week}, errors: ${plan.milestones.errors.join('; ') || 'none'}`]
    : []
  const tagErrors = plan.tagErrors?.length ? [`task tags errors: ${plan.tagErrors.join('; ')}`] : []
  return [
    ...plan.order.map((row, i) => renderScoredRow(row, i + 1)),
    ...milestones,
    ...tagErrors,
    `scope=${plan.scope} initiatives, ${plan.open} open, skipped: ${plan.skipped.length}, refused={${refused}}`,
  ]
}
