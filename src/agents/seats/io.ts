import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import path from 'node:path'
import type { AgentEventRow } from '../../broker/event-store.js'
import { home } from '../../paths.js'
import type { EventKind } from '../../protocol.js'
import { activeWorkRoot } from '../active-work.js'
import type { SeatState } from './watchdog.js'

/** The watchdog's disk: autonomy files, the scorer, its own state, seat logs and events.db (read-only). */

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => DatabaseSyncType
}

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

export function loadStates(file = watchdogStatePath()): Record<string, SeatState> {
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as { seats?: Record<string, SeatState> }
    return doc.seats ?? {}
  } catch {
    return {}
  }
}

export function saveStates(states: Record<string, SeatState>, file = watchdogStatePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify({ seats: states }, null, 2)}\n`)
  fs.renameSync(tmp, file)
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** Charter section 10's format: local `logs/<seat>/<YYYY-MM-DD>.md`, each line led by local `HH:MM`. */
export function appendSeatLog(root: string, seat: string, at: Date, text: string): string {
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
  const file = path.join(root, 'logs', seat, `${day}.md`)
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

/** Every agent lifecycle row before `untilMs`, in log order. Opened read-only; never migrates. */
export function readAgentEvents(dbPath: string, untilMs: number): AgentEventRow[] {
  const db = new DatabaseSync(dbPath, { readOnly: true })
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
