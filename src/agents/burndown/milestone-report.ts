import { criticalPath, type CriticalPathResult } from './critical-path.js'
import type { DispatchRecord } from '../seats/dispatch-record.js'
import { inFlightStages, STAGES, type Stage } from './in-flight.js'
import { heldClaims, type Ledger } from './ledger.js'
import type { Milestone, MilestoneFile } from './milestones.js'
import { tagBlocks } from './plan-order.js'
import { checkToday, parseIsoDay } from './score.js'
import { parsePlanningTasks, type PlanTask, type TaggedTask } from './task-tags.js'

/**
 * CC-630: the burn-down per milestone that `burndown milestone --json` prints and the digest reads.
 * Pure: the milestone file, the tasks, the claim ledger, the seats' dispatch runs and the clock are parameters.
 *
 * - A task belongs to a milestone by its `milestone:` tag. Points are estimates; an unestimated task
 *   adds none and is listed.
 * - The critical path runs over the milestone's open tasks. A task in a dependency cycle counts as
 *   blocked, and with any cycle the path is a lower bound.
 * - An open task is in flight while `inFlightStages` gives it a stage (a held claim, an open seat run or a
 *   parked one), blocked when its milestone's gate is open or a `dep:` blocks it (as in `planOrder`),
 *   and ready otherwise.
 * - Throughput is the points of the milestone's tasks done in the last three days, today included, over three.
 */

export const THROUGHPUT_DAYS = 3

export interface ReportTask extends PlanTask {
  done: boolean
  /** ISO day the task was created. */
  created?: string
  /** ISO day the task was done. */
  doneOn?: string
}

export interface MilestoneReportInput {
  milestones: MilestoneFile
  tasks: readonly ReportTask[]
  ledger: Ledger
  /** Every seat's folded dispatch runs. */
  dispatches?: readonly DispatchRecord[]
  now: Date
  /** ISO day; the clock for days left and throughput. */
  today: string
  /** Why the whole factory is down, when it is. */
  factoryDown?: string
  /** Seats the owner stopped, each with its reason. */
  stoppedSeats?: Readonly<Record<string, string>>
}

export type { Stage } from './in-flight.js'
export type MilestoneStatus = 'on-track' | 'at-risk' | 'stopped'

export interface MilestoneReport {
  id: string
  rank: number
  seat: string
  status: MilestoneStatus
  /** Why the milestone is at risk or stopped. */
  reason?: string
  points: { scope: number; done: number; remaining: number; addedThisWeek: number; unestimated: string[] }
  criticalPath: { points: number; slices: string[]; lowerBound: boolean; cycles: string[][] }
  counts: { ready: number; blocked: number; inFlight: number }
  /** In-flight tasks by stage; the stages sum to `counts.inFlight`. */
  wip: Record<Stage, number>
  throughput: { pointsPerDay: number; days: number }
  /** `days` is the remaining path over throughput, null with no throughput; `daysLeft` is the appetite's. */
  forecast: { days: number | null; daysLeft: number }
}

export interface MilestoneReportDoc {
  week: string
  /** ISO day the week's Monday falls on. */
  weekStart: string
  today: string
  appetiteDays: number
  milestones: MilestoneReport[]
}

const DAY_MS = 86_400_000

const round2 = (n: number) => Math.round(n * 100) / 100

const isoDayOf = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10)

/** The day number of an ISO week's Monday; the week starts Monday 00:00 UTC, and week 1 holds January 4th. */
export function weekStartDay(week: string): number {
  const [year, number] = week.split('-W').map(Number) as [number, number]
  const jan4 = Date.UTC(year, 0, 4) / DAY_MS
  return jan4 - ((jan4 + 3) % 7) + (number - 1) * 7
}

interface Context {
  input: MilestoneReportInput
  tagged: TaggedTask[]
  byId: Map<string, ReportTask>
  blocks: ReturnType<typeof tagBlocks>
  stages: Map<string, Stage>
  today: number
  weekStart: number
}

const dayOf = (iso: string | undefined) => (iso === undefined ? undefined : parseIsoDay(iso.slice(0, 10)))

const pointsOf = (tasks: readonly TaggedTask[]) =>
  round2(tasks.reduce((sum, t) => sum + (t.estimate ?? 0), 0))

function pointsReport(members: TaggedTask[], ctx: Context): MilestoneReport['points'] {
  const done = members.filter(t => ctx.byId.get(t.id)!.done)
  const added = members.filter(t => (dayOf(ctx.byId.get(t.id)!.created) ?? -Infinity) >= ctx.weekStart)
  const scope = pointsOf(members)
  return {
    scope,
    done: pointsOf(done),
    remaining: round2(scope - pointsOf(done)),
    addedThisWeek: pointsOf(added),
    unestimated: members.filter(t => t.estimate === undefined).map(t => t.id),
  }
}

function countsAndWip(open: TaggedTask[], milestone: Milestone, ctx: Context) {
  const flying = open.flatMap(t => ctx.stages.get(t.id) ?? [])
  const gated = milestone.gate?.state === 'open'
  const waiting = open.filter(t => !ctx.stages.has(t.id))
  const blocked = waiting.filter(t => gated || ctx.blocks.has(t.id)).length
  const wip = Object.fromEntries(STAGES.map(s => [s, flying.filter(f => f === s).length])) as Record<
    Stage,
    number
  >
  return { counts: { ready: waiting.length - blocked, blocked, inFlight: flying.length }, wip }
}

function throughputOf(members: TaggedTask[], ctx: Context): number {
  const since = ctx.today - THROUGHPUT_DAYS + 1
  const recent = members.filter(t => {
    const task = ctx.byId.get(t.id)!
    const day = dayOf(task.doneOn)
    return task.done && day !== undefined && day >= since && day <= ctx.today
  })
  return round2(pointsOf(recent) / THROUGHPUT_DAYS)
}

type Verdict = Pick<MilestoneReport, 'status' | 'reason'>

function stopOf(milestone: Milestone, input: MilestoneReportInput): string | undefined {
  if (input.factoryDown !== undefined) return `factory down: ${input.factoryDown}`
  const seatStop = input.stoppedSeats?.[milestone.seat]
  if (seatStop !== undefined) return `seat ${milestone.seat} stopped: ${seatStop}`
  if (milestone.gate?.state === 'open') return `gate open: ${milestone.gate.by}`
  return undefined
}

function verdict(
  milestone: Milestone,
  path: CriticalPathResult,
  forecast: MilestoneReport['forecast'],
  input: MilestoneReportInput,
): Verdict {
  const stop = stopOf(milestone, input)
  if (stop !== undefined) return { status: 'stopped', reason: stop }
  if (path.lowerBound) return { status: 'at-risk', reason: 'dependency cycle' }
  if (path.length === 0) return { status: 'on-track' }
  if (forecast.days === null)
    return { status: 'at-risk', reason: `no points done in ${THROUGHPUT_DAYS} days` }
  if (forecast.days > forecast.daysLeft)
    return { status: 'at-risk', reason: `forecast ${forecast.days}d past ${forecast.daysLeft}d left` }
  return { status: 'on-track' }
}

function reportOne(milestone: Milestone, ctx: Context): MilestoneReport {
  const members = ctx.tagged.filter(t => t.milestone === milestone.id)
  const open = members.filter(t => !ctx.byId.get(t.id)!.done)
  const path = criticalPath(open, milestone.id)
  const pointsPerDay = throughputOf(members, ctx)
  const forecast = {
    days: pointsPerDay > 0 ? round2(path.length / pointsPerDay) : null,
    daysLeft: Math.max(0, ctx.weekStart + ctx.input.milestones.appetiteDays - ctx.today),
  }
  return {
    id: milestone.id,
    rank: milestone.rank,
    seat: milestone.seat,
    ...verdict(milestone, path, forecast, ctx.input),
    points: pointsReport(members, ctx),
    criticalPath: {
      points: path.length,
      slices: path.criticalPath,
      lowerBound: path.lowerBound,
      cycles: path.cycles,
    },
    ...countsAndWip(open, milestone, ctx),
    throughput: { pointsPerDay, days: THROUGHPUT_DAYS },
    forecast,
  }
}

function context(input: MilestoneReportInput): Context {
  const byId = new Map<string, ReportTask>()
  for (const task of input.tasks) if (!byId.has(task.id)) byId.set(task.id, task)
  const { tasks: tagged } = parsePlanningTasks([...byId.values()])
  const open = tagged.filter(t => !byId.get(t.id)!.done)
  return {
    input,
    tagged,
    byId,
    blocks: tagBlocks(open, criticalPath(open).cycles),
    stages: inFlightStages(heldClaims(input.ledger), input.dispatches ?? [], input.now),
    today: checkToday(input.today),
    weekStart: weekStartDay(input.milestones.week),
  }
}

/** Every milestone of the week's file, in rank order. */
export function milestoneReport(input: MilestoneReportInput): MilestoneReportDoc {
  const ctx = context(input)
  const { week, appetiteDays, milestones } = input.milestones
  return {
    week,
    weekStart: isoDayOf(ctx.weekStart),
    today: input.today,
    appetiteDays,
    milestones: milestones.map(m => reportOne(m, ctx)),
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** One line per milestone: the digest's, and `burndown milestone` without `--json`. */
export function renderMilestoneLine(m: MilestoneReport): string {
  const status = m.reason === undefined ? m.status : `${m.status} (${m.reason})`
  const { points, criticalPath: path, counts, forecast } = m
  const bound = path.lowerBound ? ` at least, ${plural(path.cycles.length, 'cycle')}` : ''
  const eta = forecast.days === null ? 'no forecast' : `forecast ${forecast.days}d`
  return (
    `${m.id} ${status}: ${points.done}/${points.scope} points done, +${points.addedThisWeek} this week; ` +
    `path ${path.points}${bound}; ${counts.ready} ready, ${counts.blocked} blocked, ${counts.inFlight} in flight; ` +
    `${m.throughput.pointsPerDay} points/day, ${eta} vs ${forecast.daysLeft}d left`
  )
}
