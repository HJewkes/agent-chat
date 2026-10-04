import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { burndownLedgerPath } from '../../paths.js'
import { taskScalars } from '../active-work.js'
import { readDispatches } from '../seats/dispatch-read.js'
import type { DispatchRecord } from '../seats/dispatch-record.js'
import { loadDoc } from '../seats/io.js'
import { readLedger } from './ledger.js'
import { milestoneReport, type MilestoneReportDoc, type ReportTask } from './milestone-report.js'
import { parseIsoDay } from './score.js'
import { describeError, readWeekMilestones, taskIdsOnDisk } from './score-render.js'

/** CC-630: the milestone report's inputs read from disk. CLI-only; `milestoneReport` is the pure part. */

/** An ISO day from a YAML date, a `YYYYMMDD` number, or a timestamp; undefined when none parses. */
function isoDay(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const text = String(value)
    .replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')
    .slice(0, 10)
  return parseIsoDay(text) === undefined ? undefined : text
}

/** One task file as a report task; undefined when it is malformed or neither open nor done. */
export function reportTaskOf(yamlText: string): ReportTask | undefined {
  let raw: unknown
  try {
    raw = parse(yamlText)
  } catch {
    return undefined
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const t = raw as Record<string, unknown>
  if (typeof t.id !== 'string' || (t.status !== 'open' && t.status !== 'done')) return undefined
  const created = isoDay(t.created)
  const doneOn = isoDay(t.done_at)
  return {
    id: t.id,
    done: t.status === 'done',
    ...(typeof t.estimate === 'number' && { estimate: t.estimate }),
    ...(Array.isArray(t.tags) && { tags: t.tags }),
    ...(created !== undefined && { created }),
    ...(doneOn !== undefined && { doneOn }),
  }
}

const listYml = (dir: string): string[] => {
  try {
    return fs
      .readdirSync(dir)
      .filter(name => name.endsWith('.yml'))
      .map(name => path.join(dir, name))
  } catch {
    return []
  }
}

/** Every open task, and every done one that names a milestone, under `<root>/<slug>/tasks` and its archive. */
export function readReportTasks(root: string): ReportTask[] {
  const slugs = fs.existsSync(root) ? fs.readdirSync(root).filter(s => !s.startsWith('.')) : []
  return slugs.flatMap(slug => {
    const dir = path.join(root, slug, 'tasks')
    return [...listYml(dir), ...listYml(path.join(dir, 'archive'))].flatMap(file => {
      const text = fs.readFileSync(file, 'utf8')
      const status = taskScalars(text).status
      const wanted = status === 'open' || (status === 'done' && text.includes('milestone:'))
      return (wanted && reportTaskOf(text)) || []
    })
  })
}

/** Every seat's folded dispatch runs; a seat with no readable log adds none. */
export function readSeatDispatches(autonomyRoot: string): DispatchRecord[] {
  return seatNames(autonomyRoot).flatMap(seat => {
    try {
      return readDispatches(autonomyRoot, seat).records
    } catch {
      return []
    }
  })
}

function seatNames(autonomyRoot: string): string[] {
  try {
    return fs
      .readdirSync(path.join(autonomyRoot, 'seats'))
      .filter(name => name.endsWith('.md'))
      .map(name => name.slice(0, -'.md'.length))
  } catch {
    return []
  }
}

export interface MilestoneReportRead extends MilestoneReportDoc {
  /** The milestone file's validation errors; the report still uses what parsed. */
  errors: string[]
}

/** This week's milestone report; undefined when the week has no milestone file, and throws when it does not parse. */
export function milestoneReportFromDisk(opts: {
  autonomyRoot: string
  activeWorkRoot: string
  now: Date
  today: string
}): MilestoneReportRead | undefined {
  const read = readWeekMilestones(opts.autonomyRoot, opts.today, taskIdsOnDisk(opts.activeWorkRoot))
  if (read === undefined) return undefined
  const errors = read.errors.map(describeError)
  if (read.file === undefined) throw new Error(`milestones/${read.week}.yml: ${errors.join('; ')}`)
  const watchdog = loadDoc()
  const doc = milestoneReport({
    milestones: read.file,
    tasks: readReportTasks(opts.activeWorkRoot),
    ledger: readLedger(burndownLedgerPath()),
    dispatches: readSeatDispatches(opts.autonomyRoot),
    now: opts.now,
    today: opts.today,
    stoppedSeats: watchdog.stopped,
    ...(watchdog.held === true && { factoryDown: 'every seat held at the last watchdog run' }),
  })
  return { ...doc, errors }
}
