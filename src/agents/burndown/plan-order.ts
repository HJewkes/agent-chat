import { criticalPath } from './critical-path.js'
import type { Milestone, MilestoneFile } from './milestones.js'
import {
  checkToday,
  compareRows,
  dispatchOrder,
  namedDependencies,
  parseIsoDay,
  type DispatchRow,
  type ScoreRow,
  type ScoredTask,
  type ScoringDefaults,
} from './score.js'
import { parsePlanningTasks, type TagError, type TaggedTask } from './task-tags.js'

/**
 * CC-628: `planOrder`, the class-of-service order over the seat's scored rows. Pure: the milestone
 * file and `today` are parameters. Ready rows go by tier, then by the tier's own order:
 *
 * 0 expedite (oldest first), 1 fixed date with under 2 days of slack (least slack first),
 * 2 milestone the seat owns (rank, total float, WSJF descending, oldest), 3 standard (`dispatchOrder`),
 * 4 intangible (`dispatchOrder`, and only when tiers 0 to 3 have no ready row).
 *
 * Readiness, beyond the prose dependencies `dispatchOrder` already drops:
 * - A `dep:` on an open task (any task in `tasks`) blocks. A `dep:` on a task in `knownIds` only, such
 *   as a done or archived one, is taken as closed, so `criticalPath`'s `externalDeps` block only when
 *   they name an open task. One naming no task in `tasks` or `knownIds` fails closed (CC-711): the task
 *   is refused as `unknown-dep` and the dep is an `unknown-dep` in `tagErrors` (CC-631), so a typo
 *   holds the task instead of releasing it.
 * - A task in a dependency cycle, and every task that reaches one through `dep:` edges, is blocked.
 * - An unestimated task stays ready: it only adds no points to the path, and `route` sends it to triage.
 * - A task in a milestone whose gate is open yields nothing.
 * - CC-769: an epic of an owned milestone never takes tier 2. One its `epics:` lists is refused as
 *   `epic:<milestone>`, one estimated at `EPIC_ESTIMATE` points or more as `epic-estimate:<milestone>`;
 *   `epicsHeld` names each. Float would otherwise put the biggest isolated task first.
 *
 * The tier-3 daily share cap belongs to the dispatcher; each row carries its tier for it.
 */

export const SLACK_DAYS = 2
export const EPIC_ESTIMATE = 8

export type Tier = 0 | 1 | 2 | 3 | 4

/** A `dispatchOrder` row plus its plan fields; tiers 0 to 2 take `effective` as the raw score. */
export interface PlannedRow extends DispatchRow {
  tier: Tier
  /** Cost of delay over size; undefined without a positive estimate. */
  wsjf?: number
  /** Total float inside the row's milestone; tier 2 only. */
  float?: number
  /** Days from today to the due date, less the remaining path in points read as days; tier 1 only. */
  slack?: number
  milestone?: string
}

export interface PlanOrderInput {
  /** `scoreAll`'s rows. */
  rows: readonly ScoreRow[]
  /** Every open task in scope, excluded ones included: the source of the planning tags and `dep:` edges. */
  tasks: readonly ScoredTask[]
  defaults: ScoringDefaults
  n: number
  /** ISO day; the clock for slack. */
  today: string
  seat?: string
  milestones?: MilestoneFile
  priorPicks?: Readonly<Record<string, number>>
  /** Task ids outside `tasks` that a `dep:` may name, such as closed tasks. */
  knownIds?: Iterable<string>
}

export interface PlanOrder {
  order: PlannedRow[]
  /** `dispatchOrder`'s share-cap skips, then `dep-blocked`, `cycle-blocked`, `unknown-dep`, `gated:<id>` and `intangible-held`. */
  refused: Record<string, number>
  /** The planning-tag errors of `tasks`; the order still uses what parsed. */
  tagErrors: TagError[]
  /** The ready intangible tasks held back for a ready tier 0 to 3 row; `refused['intangible-held']` counts them. */
  intangibleHeld: string[]
  /** CC-769: `<id> <reason>` for each epic held out of tier 2; `refused` counts them under the same reason. */
  epicsHeld: string[]
}

type BlockReason = 'cycle-blocked' | 'unknown-dep' | 'dep-blocked'

/**
 * Tasks in a cycle and their transitive dependents, then the `unknownDeps` tasks (a `dep:` naming no
 * known task), then any other task with a `dep:` on an open task.
 */
export function tagBlocks(
  tagged: readonly TaggedTask[],
  cycles: readonly string[][],
  unknownDeps: ReadonlySet<string> = new Set(),
): Map<string, BlockReason> {
  const reasons = new Map<string, BlockReason>(cycles.flat().map(id => [id, 'cycle-blocked']))
  for (let grew = true; grew;) {
    grew = false
    for (const task of tagged) {
      if (reasons.has(task.id) || !task.deps.some(dep => reasons.has(dep))) continue
      reasons.set(task.id, 'cycle-blocked')
      grew = true
    }
  }
  for (const id of unknownDeps) if (!reasons.has(id)) reasons.set(id, 'unknown-dep')
  const open = new Set(tagged.map(task => task.id))
  for (const task of tagged) {
    if (!reasons.has(task.id) && task.deps.some(dep => open.has(dep))) reasons.set(task.id, 'dep-blocked')
  }
  return reasons
}

/** Severity weight times one plus capped unblocks, over the estimate. */
export function wsjf(row: ScoreRow, unblocks = row.unblocks): number | undefined {
  if (row.estimate === null || row.estimate <= 0) return undefined
  return (row.components.S * (1 + Math.min(unblocks, 3))) / row.estimate
}

/** Open tasks per id by prose or `dep:` tag; a task naming an id both ways counts once. */
function unblocksByTask(tasks: readonly ScoredTask[], tagged: readonly TaggedTask[]): Map<string, number> {
  const open = new Set(tasks.map(task => task.id))
  const dependents = new Map<string, Set<string>>()
  const add = (id: string, dependent: string) => {
    if (open.has(id) && id !== dependent) dependents.set(id, (dependents.get(id) ?? new Set()).add(dependent))
  }
  for (const task of tasks) for (const id of namedDependencies(task)) add(id, task.id)
  for (const task of tagged) for (const id of task.deps) add(id, task.id)
  return new Map([...dependents].map(([id, set]) => [id, set.size]))
}

interface PlanContext {
  tags: Map<string, TaggedTask>
  tagErrors: TagError[]
  blocks: Map<string, BlockReason>
  remainingPath: Map<string, number>
  unblocks: Map<string, number>
  owned: Map<string, Milestone>
  /** Total float of each task in an owned milestone. */
  floats: Map<string, number>
  today: number
}

function slackOf(task: TaggedTask, ctx: PlanContext): number | undefined {
  const due = task.due === undefined ? undefined : parseIsoDay(task.due)
  if (due === undefined) return undefined
  return due - ctx.today - (ctx.remainingPath.get(task.id) ?? 0)
}

type PlanExtra = Pick<PlannedRow, 'float' | 'slack' | 'milestone'>
type Placement = { tier: Tier; extra?: PlanExtra } | { refusal: string }

function placeTagged(task: TaggedTask, ctx: PlanContext): Placement {
  const block = ctx.blocks.get(task.id)
  if (block) return { refusal: block }
  if (task.cos === 'expedite') return { tier: 0 }
  const slack = task.cos === 'fixed' ? slackOf(task, ctx) : undefined
  if (slack !== undefined && slack < SLACK_DAYS) return { tier: 1, extra: { slack } }
  if (task.cos === 'intangible') return { tier: 4 }
  const milestone = task.milestone === undefined ? undefined : ctx.owned.get(task.milestone)
  if (milestone === undefined) return { tier: 3 }
  if (milestone.gate?.state === 'open') return { refusal: `gated:${milestone.id}` }
  if (milestone.epics.includes(task.id)) return { refusal: `epic:${milestone.id}` }
  if ((task.estimate ?? 0) >= EPIC_ESTIMATE) return { refusal: `epic-estimate:${milestone.id}` }
  return { tier: 2, extra: { float: ctx.floats.get(task.id)!, milestone: milestone.id } }
}

/** A row `dispatchOrder` would drop as blocked stays in tier 3, where it still drops. */
function place(row: ScoreRow, ctx: PlanContext): Placement {
  const task = ctx.tags.get(row.id)
  return row.blocked.length > 0 || task === undefined ? { tier: 3 } : placeTagged(task, ctx)
}

function floatsOf(tagged: readonly TaggedTask[], owned: readonly Milestone[]): Map<string, number> {
  const floats = new Map<string, number>()
  for (const { id } of owned) {
    for (const task of criticalPath(tagged, id).tasks) floats.set(task.id, task.float)
  }
  return floats
}

const unknownDepTasks = (errors: readonly TagError[]) =>
  new Set(errors.filter(error => error.code === 'unknown-dep').map(error => error.task))

function planContext(input: PlanOrderInput): PlanContext {
  const { tasks: tagged, errors: tagErrors } = parsePlanningTasks(input.tasks, input.knownIds)
  const whole = criticalPath(tagged)
  const owned = (input.milestones?.milestones ?? []).filter(m => m.seat === input.seat)
  return {
    tags: new Map(tagged.map(task => [task.id, task])),
    tagErrors,
    blocks: tagBlocks(tagged, whole.cycles, unknownDepTasks(tagErrors)),
    unblocks: unblocksByTask(input.tasks, tagged),
    remainingPath: new Map(whole.tasks.map(task => [task.id, task.earlyFinish])),
    owned: new Map(owned.map(m => [m.id, m])),
    floats: floatsOf(tagged, owned),
    today: checkToday(input.today),
  }
}

const byAge = (a: PlannedRow, b: PlannedRow) => b.ageDays - a.ageDays || compareRows(a, b)
const descendingOrLast = (a?: number, b?: number) => (b ?? -Infinity) - (a ?? -Infinity)

function tierOrder(tier: 0 | 1 | 2, owned: Map<string, Milestone>): (a: PlannedRow, b: PlannedRow) => number {
  if (tier === 0) return byAge
  if (tier === 1) return (a, b) => a.slack! - b.slack! || byAge(a, b)
  const rank = (planned: PlannedRow) => owned.get(planned.milestone!)!.rank
  return (a, b) => rank(a) - rank(b) || a.float! - b.float! || descendingOrLast(a.wsjf, b.wsjf) || byAge(a, b)
}

interface Sorted {
  /** Tiers 0 to 2 as planned rows; tiers 3 and 4 as rows for `dispatchOrder`. */
  ranked: [PlannedRow[], PlannedRow[], PlannedRow[]]
  standard: ScoreRow[]
  intangible: ScoreRow[]
  refused: Record<string, number>
  epicsHeld: string[]
}

const isEpicRefusal = (refusal: string) => refusal.startsWith('epic:') || refusal.startsWith('epic-estimate:')

function planned(
  row: ScoreRow & { effective?: number },
  tier: Tier,
  ctx: PlanContext,
  extra: PlanExtra = {},
): PlannedRow {
  const weight = wsjf(row, ctx.unblocks.get(row.id) ?? 0)
  return {
    ...row,
    effective: row.effective ?? row.score,
    tier,
    ...(weight !== undefined && { wsjf: weight }),
    ...extra,
  }
}

const bump = (counts: Record<string, number>, key: string, n = 1) => {
  counts[key] = (counts[key] ?? 0) + n
}

function sortRows(rows: readonly ScoreRow[], ctx: PlanContext): Sorted {
  const sorted: Sorted = { ranked: [[], [], []], standard: [], intangible: [], refused: {}, epicsHeld: [] }
  for (const row of rows) {
    const placement = place(row, ctx)
    if ('refusal' in placement) {
      bump(sorted.refused, placement.refusal)
      if (isEpicRefusal(placement.refusal)) sorted.epicsHeld.push(`${row.id} ${placement.refusal}`)
    } else if (placement.tier === 3) sorted.standard.push(row)
    else if (placement.tier === 4) sorted.intangible.push(row)
    else sorted.ranked[placement.tier].push(planned(row, placement.tier, ctx, placement.extra))
  }
  return sorted
}

function addCounts(into: Record<string, number>, from: Readonly<Record<string, number>>): void {
  for (const [key, n] of Object.entries(from)) bump(into, key, n)
}

/** Each pick so far counts toward its initiative's decay in `dispatchOrder`. */
function picksAfter(
  prior: Readonly<Record<string, number>>,
  picked: readonly PlannedRow[],
): Record<string, number> {
  const picks = { ...prior }
  for (const { initiative } of picked) bump(picks, initiative)
  return picks
}

function dispatched(
  rows: readonly ScoreRow[],
  tier: 3 | 4,
  input: PlanOrderInput,
  picked: PlannedRow[],
  ctx: PlanContext,
) {
  const { order, refused } = dispatchOrder(
    rows,
    input.defaults,
    input.n - picked.length,
    picksAfter(input.priorPicks ?? {}, picked),
  )
  return { order: order.map(row => planned(row, tier, ctx)), refused }
}

const hasReady = (rows: readonly ScoreRow[]) => rows.some(row => row.blocked.length === 0)

/** The seat's dispatch order by class-of-service tier; with no planning tags it is `dispatchOrder`'s. */
export function planOrder(input: PlanOrderInput): PlanOrder {
  const ctx = planContext(input)
  const sorted = sortRows(input.rows, ctx)
  const picked = ([0, 1, 2] as const).flatMap(tier => sorted.ranked[tier].sort(tierOrder(tier, ctx.owned)))
  const order = picked.slice(0, Math.max(0, input.n))
  const standard = dispatched(sorted.standard, 3, input, order, ctx)
  const refused = { ...standard.refused }
  order.push(...standard.order)
  const intangibleHeld: string[] = []
  if (picked.length > 0 || hasReady(sorted.standard)) {
    const held = sorted.intangible.filter(row => row.blocked.length === 0)
    intangibleHeld.push(...held.map(row => row.id))
    if (held.length > 0) sorted.refused['intangible-held'] = held.length
  } else {
    const intangible = dispatched(sorted.intangible, 4, input, order, ctx)
    addCounts(refused, intangible.refused)
    order.push(...intangible.order)
  }
  addCounts(refused, sorted.refused)
  return { order, refused, tagErrors: ctx.tagErrors, intangibleHeld, epicsHeld: sorted.epicsHeld }
}
