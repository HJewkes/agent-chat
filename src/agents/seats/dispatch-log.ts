import fs from 'node:fs'
import path from 'node:path'
import { logEvent } from '../../broker/log.js'
import { activeWorkRoot, frontmatterField } from '../active-work.js'
import { parseTask } from '../burndown/source.js'
import { dispatchedRow, retiredRow, type DispatchRun, type RetireSpend } from './dispatch-record.js'
import { taskOf } from './journal-line.js'
import { readText } from './io.js'
import { seatOf, type SeatFile } from './seat-of.js'

/** CC-330: the broker's side of a seat's dispatch log, one appended line per verified spawn and per retire. */

/** What the broker knows at a spawn; the writer adds the time, the seat and the task. */
export type SpawnFacts = Omit<DispatchRun, 'ts' | 'task' | 'initiative' | 'kind'>

/** Never throws and returns nothing: a dispatch row must not fail the spawn or retire that caused it. */
export interface SeatDispatchLog {
  dispatched: (spawn: SpawnFacts) => void
  retired: (spawn: SpawnFacts, sessionId: string | null, spend: RetireSpend) => void
}

type Log = (event: string, detail: Record<string, unknown>) => void

export interface DispatchLogDeps {
  now?: () => Date
  log?: Log
  /** Where task files are looked up; defaults to active-work's root. */
  activeWork?: string
}

const UNAVAILABLE = 'seat_dispatch_unavailable'
const AMBIGUOUS = 'seat_dispatch_ambiguous'
const REFUSED = 'seat_dispatch_refused'

type Row = ReturnType<typeof dispatchedRow> | ReturnType<typeof retiredRow>

/** The writer over the autonomy root at `root`. Each problem is logged once per writer and retried silently. */
export function seatDispatchLog(root: string, deps: DispatchLogDeps = {}): SeatDispatchLog {
  const reported = new Set<string>()
  const log = deps.log ?? logEvent
  const once = (key: string, event: string, detail: Record<string, unknown>): void => {
    if (reported.has(key)) return
    reported.add(key)
    log(event, detail)
  }
  const context: WriteContext = { root, activeWork: deps.activeWork ?? activeWorkRoot(), once }
  const write = (spawn: SpawnFacts, rowOf: (run: DispatchRun) => Row): void => {
    try {
      writeRow(context, spawn, (deps.now?.() ?? new Date()).toISOString(), rowOf)
    } catch (err) {
      once(UNAVAILABLE, UNAVAILABLE, { reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return {
    dispatched: spawn => write(spawn, dispatchedRow),
    retired: (spawn, sessionId, spend) => write(spawn, run => retiredRow(run, sessionId, spend)),
  }
}

interface WriteContext {
  root: string
  activeWork: string
  once: (key: string, event: string, detail: Record<string, unknown>) => void
}

function writeRow(ctx: WriteContext, spawn: SpawnFacts, ts: string, rowOf: (run: DispatchRun) => Row): void {
  const match = seatOf(ctx.root, spawn.agent, spawn.spawner ?? undefined)
  if (match.kind === 'ambiguous') {
    return ctx.once(`${AMBIGUOUS}:${match.prefix}`, AMBIGUOUS, { prefix: match.prefix, seats: match.seats })
  }
  if (match.kind === 'none') return
  const file = dispatchLogPath(ctx.root, match.seat)
  if (file === undefined) {
    const seat = match.seat.seat.name
    return ctx.once(`${REFUSED}:${seat}`, REFUSED, { seat, reason: 'dispatch_log resolves outside the root' })
  }
  const task = taskOf(spawn.agent, match.seat.seat.prefix) ?? null
  const run: DispatchRun = { ...spawn, ts, task, ...taskContext(ctx.activeWork, task) }
  appendRow(file, rowOf(run))
}

/** The seat's `dispatch_log` under `root`, else `logs/<seat>/dispatch.jsonl`; undefined when it resolves outside `root`. */
export function dispatchLogPath(root: string, { seat, text }: SeatFile): string | undefined {
  const declared = frontmatterField(text, 'dispatch_log') ?? path.join('logs', seat.name, 'dispatch.jsonl')
  const file = path.resolve(root, declared)
  const inside = path.relative(path.resolve(root), file)
  if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) return undefined
  return file
}

/** The initiative and `kind:` tag of the first active-work task file for `task`; nulls when none exists. */
function taskContext(
  activeWork: string,
  task: string | null,
): { initiative: string | null; kind: string | null } {
  const none = { initiative: null, kind: null }
  if (task === null) return none
  for (const slug of initiatives(activeWork)) {
    const text = readText(path.join(activeWork, slug, 'tasks', `${task}.yml`))
    if (text === undefined) continue
    const tag = parseTask(text, task).tags.find(t => t.startsWith('kind:'))
    return { initiative: slug, kind: tag === undefined ? null : tag.slice('kind:'.length) }
  }
  return none
}

function initiatives(activeWork: string): string[] {
  try {
    return fs.readdirSync(activeWork).sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

/** One O_APPEND write of a whole line, as a seat's `echo >>` is, so neither writer can split the other's line. */
function appendRow(file: string, row: Row): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const lead = endsUnterminated(file) ? '\n' : ''
  fs.appendFileSync(file, `${lead}${JSON.stringify(row)}\n`)
}

function endsUnterminated(file: string): boolean {
  let fd: number
  try {
    fd = fs.openSync(file, 'r')
  } catch {
    return false
  }
  try {
    const size = fs.fstatSync(fd).size
    if (size === 0) return false
    const last = Buffer.alloc(1)
    fs.readSync(fd, last, 0, 1, size - 1)
    return last[0] !== 0x0a
  } finally {
    fs.closeSync(fd)
  }
}
