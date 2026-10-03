import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { logEvent } from '../../broker/log.js'
import { activeWorkRoot, frontmatterField } from '../active-work.js'
import { parseTask } from '../burndown/source.js'
import {
  abandonedRow,
  dispatchedRow,
  retiredRow,
  type DispatchRun,
  type RetireSpend,
} from './dispatch-record.js'
import { taskOf } from './journal-line.js'
import { readText } from './io.js'
import { seatOf, type SeatFile } from './seat-of.js'

/** CC-330: the broker's side of a seat's dispatch log, one appended line per verified spawn and per retire. */

/** What the broker knows at a spawn; the writer adds the time, the seat and the task. */
export type SpawnFacts = Omit<DispatchRun, 'ts' | 'task' | 'initiative' | 'kind'>

/** Never throws and returns nothing: a dispatch row must not fail the spawn or retire that caused it. */
export interface SeatDispatchLog {
  dispatched: (spawn: SpawnFacts) => void
  abandoned: (spawn: SpawnFacts) => void
  retired: (spawn: SpawnFacts, sessionId: string | null, spend: RetireSpend) => void
}

type Log = (event: string, detail: Record<string, unknown>) => void

export interface DispatchLogDeps {
  now?: () => Date
  log?: Log
  /** Where task files are looked up; defaults to active-work's root. */
  activeWork?: string
  /** The stat used to re-check an opened log against its path; injectable so a directory swap can be simulated. */
  stat?: (file: string) => fs.Stats
}

const UNAVAILABLE = 'seat_dispatch_unavailable'
const AMBIGUOUS = 'seat_dispatch_ambiguous'
const REFUSED = 'seat_dispatch_refused'
const OUTSIDE = 'dispatch_log resolves outside the root'
const NOT_REGULAR = 'dispatch_log is not a regular file'
/** What open reports for a socket: a code on Linux, a bare errno on macOS. */
const NO_OPEN = new Set(['ENXIO', 'EOPNOTSUPP'])
const NO_OPEN_ERRNO = new Set([-os.constants.errno.ENXIO, -os.constants.errno.EOPNOTSUPP])
const UNREADABLE = 'seat_dispatch_seat_unreadable'

/** CC-469: the tick's end-state row for a merged PR, read by the fold as a seat's own row since it is not the broker's. */
export interface MergedRow {
  ts: string
  task: string | null
  agent: string
  pr: string
  outcome: 'merged'
  by: 'burndown'
}

type Row =
  | ReturnType<typeof dispatchedRow>
  | ReturnType<typeof retiredRow>
  | ReturnType<typeof abandonedRow>
  | MergedRow

/** The writer over the autonomy root at `root`. Each problem is logged once per writer and retried silently. */
export function seatDispatchLog(root: string, deps: DispatchLogDeps = {}): SeatDispatchLog {
  const context = contextOf(root, deps)
  const { once } = context
  const write = (spawn: SpawnFacts, rowOf: (run: DispatchRun) => Row): void => {
    try {
      writeRow(context, spawn, (deps.now?.() ?? new Date()).toISOString(), rowOf)
    } catch (err) {
      once(UNAVAILABLE, UNAVAILABLE, { reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return {
    dispatched: spawn => write(spawn, dispatchedRow),
    abandoned: spawn => write(spawn, abandonedRow),
    retired: (spawn, sessionId, spend) => write(spawn, run => retiredRow(run, sessionId, spend)),
  }
}

/** Each problem is logged once per writer and retried silently. */
function contextOf(root: string, deps: DispatchLogDeps): WriteContext {
  const reported = new Set<string>()
  const log = deps.log ?? logEvent
  const once = (key: string, event: string, detail: Record<string, unknown>): void => {
    if (reported.has(key)) return
    reported.add(key)
    log(event, detail)
  }
  const stat = deps.stat ?? ((file: string) => fs.statSync(file))
  return { root, activeWork: deps.activeWork ?? activeWorkRoot(), once, stat }
}

interface WriteContext {
  root: string
  activeWork: string
  once: (key: string, event: string, detail: Record<string, unknown>) => void
  stat: (file: string) => fs.Stats
}

/** Where an agent's rows go and the task its name carries; undefined when no one seat owns it. */
interface Target {
  file: string
  task: string | null
  refuse: (reason?: string) => void
}

function targetOf(ctx: WriteContext, agent: string, spawner: string | undefined): Target | undefined {
  const unreadable = (seat: string): void => ctx.once(`${UNREADABLE}:${seat}`, UNREADABLE, { seat })
  const match = seatOf(ctx.root, agent, spawner, unreadable)
  if (match.kind === 'ambiguous') {
    ctx.once(`${AMBIGUOUS}:${match.prefix}`, AMBIGUOUS, { prefix: match.prefix, seats: match.seats })
    return undefined
  }
  if (match.kind === 'none') return undefined
  const seat = match.seat.seat.name
  const refuse = (reason = OUTSIDE): void => ctx.once(`${REFUSED}:${seat}`, REFUSED, { seat, reason })
  const file = dispatchLogPath(ctx.root, match.seat)
  if (file === undefined) return void refuse()
  return { file, task: taskOf(agent, match.seat.seat.prefix) ?? null, refuse }
}

function appendTo(ctx: WriteContext, target: Target, row: Row, skip?: (log: string) => boolean): void {
  try {
    appendRow(ctx, target.file, row, skip)
  } catch (err) {
    if (!(err instanceof Escape)) throw err
    target.refuse(err.message)
  }
}

function writeRow(ctx: WriteContext, spawn: SpawnFacts, ts: string, rowOf: (run: DispatchRun) => Row): void {
  const target = targetOf(ctx, spawn.agent, spawn.spawner ?? undefined)
  if (target === undefined) return
  const run: DispatchRun = { ...spawn, ts, task: target.task, ...taskContext(ctx.activeWork, target.task) }
  appendTo(ctx, target, rowOf(run))
}

/** CC-469: appends `merged` for `agent` and `pr` (`owner/repo#n`); never throws, and any row already saying so wins. */
export type SeatMergedLog = (merge: { agent: string; pr: string; seat?: string }) => void

/** The tick's writer over the autonomy root at `root`, sharing the broker writer's seat match and append. */
export function seatMergedLog(root: string, deps: DispatchLogDeps = {}): SeatMergedLog {
  const ctx = contextOf(root, deps)
  return ({ agent, pr, seat }) => {
    try {
      const target = targetOf(ctx, agent, seat)
      if (target === undefined) return
      const ts = (deps.now?.() ?? new Date()).toISOString()
      const row: MergedRow = { ts, task: target.task, agent, pr, outcome: 'merged', by: 'burndown' }
      appendTo(ctx, target, row, text => hasMergedRow(text, agent, pr))
    } catch (err) {
      ctx.once(UNAVAILABLE, UNAVAILABLE, { reason: err instanceof Error ? err.message : String(err) })
    }
  }
}

/** Whether any line of `log`, hand-written or not, records `agent` merging `pr`. */
export function hasMergedRow(log: string, agent: string, pr: string): boolean {
  return log.split('\n').some(line => {
    try {
      const row: unknown = JSON.parse(line)
      if (typeof row !== 'object' || row === null) return false
      const r = row as Record<string, unknown>
      return r.outcome === 'merged' && r.agent === agent && r.pr === pr
    } catch {
      return false
    }
  })
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

/** A target that a symlink carries outside the root. */
class Escape extends Error {
  constructor(
    readonly target: string,
    reason = OUTSIDE,
  ) {
    super(reason)
  }
}

/** One O_APPEND write of a whole line, as a seat's `echo >>` is, so neither writer can split the other's line. */
function appendRow(ctx: WriteContext, file: string, row: Row, skip?: (log: string) => boolean): void {
  const fd = openInside(ctx.root, file)
  try {
    verifyOpened(ctx, fd, file)
    if (skip?.(readOpened(fd)) === true) return
    const lead = endsUnterminated(fd) ? '\n' : ''
    fs.writeSync(fd, `${lead}${JSON.stringify(row)}\n`)
  } finally {
    fs.closeSync(fd)
  }
}

/** Throws Escape unless `fd` is a regular file that is what `file` resolves to now, inside the root; O_RDWR opens a FIFO without blocking and loses the row. */
function verifyOpened(ctx: WriteContext, fd: number, file: string): void {
  const opened = fs.fstatSync(fd)
  if (!opened.isFile()) throw new Escape(file, NOT_REGULAR)
  const real = fs.realpathSync(file)
  if (!isInside(fs.realpathSync(ctx.root), real)) throw new Escape(file)
  const named = ctx.stat(real)
  if (named.dev !== opened.dev || named.ino !== opened.ino) {
    throw new Escape(file, 'dispatch_log changed between open and check')
  }
}

/** Opens `file` for append, creating its directories one level at a time; throws Escape when a symlink leaves `root`. */
function openInside(root: string, file: string): number {
  const realRoot = fs.realpathSync(root)
  let dir = realRoot
  for (const part of path
    .relative(root, path.dirname(file))
    .split(path.sep)
    .filter(p => p !== '')) {
    dir = enterInside(realRoot, path.join(dir, part))
  }
  const { O_APPEND, O_CREAT, O_RDWR, O_NOFOLLOW, O_NONBLOCK } = fs.constants
  try {
    return fs.openSync(
      path.join(dir, path.basename(file)),
      O_APPEND | O_CREAT | O_RDWR | O_NOFOLLOW | O_NONBLOCK,
      0o644,
    )
  } catch (err) {
    const { code, errno } = err as NodeJS.ErrnoException
    if (code === 'ELOOP') throw new Escape(file)
    if (NO_OPEN.has(code ?? '') || NO_OPEN_ERRNO.has(errno ?? 0)) throw new Escape(file, NOT_REGULAR)
    throw err
  }
}

/** The real path of `dir`, whose parent is already real and inside; made when missing, Escape when it leaves `realRoot`. */
function enterInside(realRoot: string, dir: string): string {
  const real = realDir(dir)
  if (!isInside(realRoot, real)) throw new Escape(dir)
  return real
}

/** The real path of `dir`, made when missing; Escape for a symlink whose target does not exist. */
function realDir(dir: string): string {
  try {
    fs.mkdirSync(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  try {
    return fs.realpathSync(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Escape(dir)
    throw err
  }
}

function isInside(realRoot: string, real: string): boolean {
  const inside = path.relative(realRoot, real)
  return inside === '' || (!inside.startsWith('..') && !path.isAbsolute(inside))
}

function readOpened(fd: number): string {
  const size = fs.fstatSync(fd).size
  const buf = Buffer.alloc(size)
  let read = 0
  while (read < size) {
    const n = fs.readSync(fd, buf, read, size - read, read)
    if (n === 0) break
    read += n
  }
  return buf.subarray(0, read).toString('utf8')
}

function endsUnterminated(fd: number): boolean {
  const size = fs.fstatSync(fd).size
  if (size === 0) return false
  const last = Buffer.alloc(1)
  fs.readSync(fd, last, 0, 1, size - 1)
  return last[0] !== 0x0a
}
