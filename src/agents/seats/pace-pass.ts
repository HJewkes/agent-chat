import fs from 'node:fs'
import path from 'node:path'
import { home } from '../../paths.js'
import type { PoolPace } from './pace.js'

/** CC-605: what one watchdog pass publishes about the pools: `pace.json` and the reading history. */

export interface PaceRow extends PoolPace {
  /** Passes in a row that ended at this level; the ladder acts on two. */
  passesAtLevel: number
}

/** `pace.json`: every charter pool's pace as of the last watchdog pass. */
export interface PaceDoc {
  /** Epoch ms of the pass that wrote it. */
  at: number
  pools: Record<string, PaceRow>
}

/** One line of `pool-readings.jsonl`, in the shape `bin/pace` wrote; times are unix seconds. */
export interface ReadingRow {
  ts: number
  pool: string
  seven_day: number
  five_hour: number
  resets_at: number
  source: 'watchdog'
  age_s: number
  /** The window had passed, so `seven_day` is an assumed 0 and no measurement. */
  rolled?: true
}

export interface PaceStore {
  /** Undefined when there is no pace file or it cannot be read. */
  read: () => PaceDoc | undefined
  write: (doc: PaceDoc) => void
  /** The watchdog pass is the one writer of the history. */
  append: (rows: ReadingRow[]) => void
  /** CC-346: the reading history so far, which outlives a deleted seat-watchdog.json. */
  rows?: () => ReadingRow[]
}

export function nextPaceDoc(
  previous: PaceDoc | undefined,
  rows: readonly PoolPace[],
  nowMs: number,
): PaceDoc {
  const pools = rows.map(row => {
    const before = previous?.pools[row.pool]
    const passesAtLevel = before?.level === row.level ? before.passesAtLevel + 1 : 1
    return [row.pool, { ...row, passesAtLevel }] as const
  })
  return { at: nowMs, pools: Object.fromEntries(pools) }
}

const sameReading = (a: PoolPace | undefined, b: PoolPace): boolean =>
  a?.sevenDay === b.sevenDay && a.fiveHour === b.fiveHour && a.resetsAt === b.resetsAt

/**
 * CC-1364: usage only rises inside one seven_day window, so a lower figure under the same reset, before
 * that reset, is a stale file's repeat and no reading.
 */
const fallInWindow = (before: PoolPace | undefined, row: PoolPace, nowMs: number): boolean =>
  row.rolled !== true &&
  before?.sevenDay != null &&
  row.sevenDay !== null &&
  before.sevenDay > row.sevenDay &&
  before.resetsAt != null &&
  row.resetsAt !== null &&
  Math.abs(before.resetsAt - row.resetsAt) <= RESET_TOLERANCE_MS &&
  nowMs < before.resetsAt

/** A row for each pool whose reading differs from the pass before; a stale one is recorded with its age. */
export function changedReadings(
  previous: PaceDoc | undefined,
  rows: readonly PoolPace[],
  nowMs: number,
): ReadingRow[] {
  return rows.flatMap(row => {
    const { sevenDay, fiveHour, resetsAt, ageSeconds } = row
    if (sevenDay === null || fiveHour === null || resetsAt === null || ageSeconds === null) return []
    const before = previous?.pools[row.pool]
    if (sameReading(before, row) || fallInWindow(before, row, nowMs)) return []
    return [
      {
        ts: Math.round(nowMs / 1000),
        pool: row.pool,
        seven_day: sevenDay,
        five_hour: fiveHour,
        resets_at: Math.round(resetsAt / 1000),
        source: 'watchdog' as const,
        age_s: ageSeconds,
        ...(row.rolled ? { rolled: true as const } : {}),
      },
    ]
  })
}

export function publishPace(store: PaceStore, rows: readonly PoolPace[], nowMs: number): void {
  const previous = store.read()
  const changed = changedReadings(previous, rows, nowMs)
  if (changed.length > 0) store.append(changed)
  store.write(nextPaceDoc(previous, rows, nowMs))
}

export interface DayOpeningQuery {
  pool: string
  /** CC-1289: every pool on `pool`'s account; rows written under any of them before the merge count. */
  pools?: readonly string[]
  dayStartMs: number
  /** The pool's current seven_day and the epoch ms its window resets. */
  sevenDay: number
  resetsAt: number | undefined
}

/** A row from before this is no reading of the day's opening: the pass was not running to record a change. */
export const DAY_OPENING_MAX_LOOKBACK_MS = 24 * 3_600_000

const RESET_TOLERANCE_MS = 3_600_000

/** A rolled row, one above the current reading, or one with another reset time read another window. */
const sameWindow = (row: ReadingRow, query: DayOpeningQuery): boolean =>
  row.rolled !== true &&
  row.seven_day <= query.sevenDay &&
  (query.resetsAt === undefined || Math.abs(row.resets_at * 1000 - query.resetsAt) <= RESET_TOLERANCE_MS)

/**
 * CC-346: the pool's reading as the spend day opened: the latest row at or before the day start and
 * within a day of it, else the day's earliest. None when that row read another seven_day window.
 */
export function dayOpening(rows: readonly ReadingRow[], query: DayOpeningQuery): ReadingRow | undefined {
  const { dayStartMs } = query
  const pools = query.pools ?? [query.pool]
  const own = rows.filter(
    row => pools.includes(row.pool) && row.ts * 1000 > dayStartMs - DAY_OPENING_MAX_LOOKBACK_MS,
  )
  const before = own.filter(row => row.ts * 1000 <= dayStartMs).sort((a, b) => b.ts - a.ts)[0]
  const opening = before ?? own.filter(row => row.ts * 1000 > dayStartMs).sort((a, b) => a.ts - b.ts)[0]
  return opening !== undefined && sameWindow(opening, query) ? opening : undefined
}

export const pacePath = (): string => path.join(home(), 'pace.json')

export const readingHistoryPath = (root: string): string => path.join(root, 'pool-readings.jsonl')

/** A missing, unparsable or misshapen file is no pace doc: the next pass rewrites it whole. */
export function readPaceDoc(file = pacePath()): PaceDoc | undefined {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<PaceDoc> | null
    const usable = typeof doc?.at === 'number' && typeof doc.pools === 'object' && doc.pools !== null
    return usable ? (doc as PaceDoc) : undefined
  } catch {
    return undefined
  }
}

export function writePaceDoc(doc: PaceDoc, file = pacePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`)
  fs.renameSync(tmp, file)
}

export function appendReadingRows(root: string, rows: readonly ReadingRow[]): void {
  fs.appendFileSync(readingHistoryPath(root), rows.map(row => `${JSON.stringify(row)}\n`).join(''))
}

const isReadingRow = (row: Partial<ReadingRow> | null): row is ReadingRow =>
  typeof row?.ts === 'number' && typeof row.pool === 'string' && typeof row.seven_day === 'number'

/** A missing history is none, and a line that does not parse as a row is skipped. */
export function readReadingRows(root: string): ReadingRow[] {
  let text: string
  try {
    text = fs.readFileSync(readingHistoryPath(root), 'utf8')
  } catch {
    return []
  }
  return text.split('\n').flatMap(line => {
    try {
      const row = JSON.parse(line) as Partial<ReadingRow> | null
      return isReadingRow(row) ? [row] : []
    } catch {
      return []
    }
  })
}

export const diskPaceStore = (root: string): PaceStore => ({
  read: () => readPaceDoc(),
  write: doc => writePaceDoc(doc),
  append: rows => appendReadingRows(root, rows),
  rows: () => readReadingRows(root),
})
