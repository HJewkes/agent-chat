import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import path from 'node:path'
import { BUSY_TIMEOUT_MS } from '../../broker/event-log.js'
import type { AgentEventRow } from '../../broker/event-store.js'
import { home } from '../../paths.js'
import type { EventKind } from '../../protocol.js'
import { activeWorkRoot } from '../active-work.js'
import type { OwnerMessage, SpendMeter } from './stops.js'
import type { SeatState } from './watchdog.js'

/** The watchdog's disk: autonomy files, the scorer, its own state, seat logs and events.db (read-only). */

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean; timeout?: number }) => DatabaseSyncType
}

/** Read-only and never migrated; waits out the broker's write lock like the broker's own connection does. */
const openEvents = (dbPath: string): DatabaseSyncType =>
  new DatabaseSync(dbPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })

export const defaultAutonomyRoot = (): string =>
  path.join(activeWorkRoot(), 'claude-channels', 'sources', 'autonomy')

export const watchdogStatePath = (): string => path.join(home(), 'seat-watchdog.json')

export const readText = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/** The scorer's eligible count for `seat`, or undefined when it cannot be run or read. */
export function scorerEligible(root: string, seat: string): number | undefined {
  try {
    const out = execFileSync(
      'python3',
      [path.join(root, 'score.py'), '--seat', seat, '--json', '--top', '1000'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 120_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
    const order = (JSON.parse(out) as { order?: unknown }).order
    return Array.isArray(order) ? order.length : undefined
  } catch {
    return undefined
  }
}

/** A seat's watchdog state, its run spend meter, and whether its pool gate was closed at the last run. */
export type SeatRecord = SeatState & { run?: SpendMeter; budgetPaused?: boolean; capped?: boolean }

/**
 * `seat-watchdog.json`. `stopped` is the owner's switch: a seat named there is
 * never woken, whatever else holds, until its entry is deleted.
 */
export interface WatchdogDoc {
  seats: Record<string, SeatRecord>
  pools: Record<string, SpendMeter>
  stopped: Record<string, string>
  /** Whether a hold on every seat (restart window, unreadable events.db) was open at the last run. */
  held?: boolean
}

export function loadDoc(file = watchdogStatePath()): WatchdogDoc {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<WatchdogDoc>
    return {
      seats: doc.seats ?? {},
      pools: doc.pools ?? {},
      stopped: doc.stopped ?? {},
      ...(doc.held === undefined ? {} : { held: doc.held }),
    }
  } catch {
    return { seats: {}, pools: {}, stopped: {} }
  }
}

/** The watchdog never writes `stopped`, so it keeps whatever the owner has on disk at save time. */
export function saveDoc(doc: Omit<WatchdogDoc, 'stopped'>, file = watchdogStatePath()): void {
  const { stopped } = loadDoc(file)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify({ ...doc, stopped }, null, 2)}\n`)
  fs.renameSync(tmp, file)
}

const pad = (n: number): string => String(n).padStart(2, '0')

const localDay = (at: Date): string => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`

export const seatLogPath = (root: string, seat: string, at: Date): string =>
  path.join(root, 'logs', seat, `${localDay(at)}.md`)

/** Charter section 10's format: local `logs/<seat>/<YYYY-MM-DD>.md`, each line led by local `HH:MM`. */
export function appendSeatLog(root: string, seat: string, at: Date, text: string): string {
  const file = seatLogPath(root, seat, at)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${pad(at.getHours())}:${pad(at.getMinutes())} ${text}\n`)
  return file
}

const AGENT_KINDS = [
  'agent_spawned',
  'agent_resumed',
  'agent_attached',
  'agent_detached',
  'agent_exited',
  'agent_retired',
]

interface Row {
  ts: number
  kind: string
  actor: string
  target: string | null
  msg_id: string | null
  ref: string | null
  body: string | null
  meta: string | null
}

const toAgentRow = (row: Row): AgentEventRow => ({
  kind: row.kind as EventKind,
  ts: row.ts,
  actor: row.actor,
  target: row.target,
  msgId: row.msg_id,
  ref: row.ref,
  body: row.body,
  meta: (row.meta ? JSON.parse(row.meta) : {}) as Record<string, string>,
})

/** Every agent lifecycle row before `untilMs`, in log order. */
export function readAgentEvents(dbPath: string, untilMs: number): AgentEventRow[] {
  const db = openEvents(dbPath)
  try {
    const marks = AGENT_KINDS.map(() => '?').join(',')
    const rows = db
      .prepare(`SELECT * FROM events WHERE kind IN (${marks}) AND ts < ? ORDER BY id`)
      .all(...AGENT_KINDS, untilMs) as unknown as Row[]
    return rows.map(toAgentRow)
  } finally {
    db.close()
  }
}

/** The owner seat's messages since `sinceMs` that mention a restart. Throws when events.db cannot be read. */
export function readOwnerMessages(dbPath: string, owner: string, sinceMs: number): OwnerMessage[] {
  const db = openEvents(dbPath)
  try {
    const rows = db
      .prepare(
        "SELECT ts, body FROM events WHERE kind IN ('message', 'broadcast') AND actor = ? AND ts >= ? AND body LIKE '%restart%' ORDER BY id",
      )
      .all(owner, sinceMs) as unknown as { ts: number; body: string | null }[]
    return rows.map(row => ({ ts: row.ts, body: row.body ?? '' }))
  } finally {
    db.close()
  }
}
