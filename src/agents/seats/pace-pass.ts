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
}

export interface PaceStore {
  /** Undefined when there is no pace file or it cannot be read. */
  read: () => PaceDoc | undefined
  write: (doc: PaceDoc) => void
  /** The watchdog pass is the one writer of the history. */
  append: (rows: ReadingRow[]) => void
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

/** A row for each pool whose reading differs from the pass before; a stale one is recorded with its age. */
export function changedReadings(
  previous: PaceDoc | undefined,
  rows: readonly PoolPace[],
  nowMs: number,
): ReadingRow[] {
  return rows.flatMap(row => {
    const { sevenDay, fiveHour, resetsAt, ageSeconds } = row
    if (sevenDay === null || fiveHour === null || resetsAt === null || ageSeconds === null) return []
    if (sameReading(previous?.pools[row.pool], row)) return []
    return [
      {
        ts: Math.round(nowMs / 1000),
        pool: row.pool,
        seven_day: sevenDay,
        five_hour: fiveHour,
        resets_at: Math.round(resetsAt / 1000),
        source: 'watchdog' as const,
        age_s: ageSeconds,
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

export const diskPaceStore = (root: string): PaceStore => ({
  read: () => readPaceDoc(),
  write: doc => writePaceDoc(doc),
  append: rows => appendReadingRows(root, rows),
})
