import fs from 'node:fs'
import path from 'node:path'
import type { AgentEventRow } from '../../broker/event-store.js'
import type { AgentIdentity } from '../../protocol.js'
import { foldAgent, groupByAgent } from '../identity.js'
import { charterSeats, isSeatName, parseSeat } from './charter.js'
import { liveCoordinators } from './coordinators.js'
import { openEvents } from './io.js'
import type { RawMessage, WatchSeat } from './seat-watch-packet.js'
import type { BudgetItem, WatchRow } from './seat-watch.js'

/** CC-1661: seat-watch's reads. events.db is opened read-only; the rows go to one JSONL file per seat. */

export interface SeatBook {
  live: WatchSeat[]
  /** Book names with no live coordinator identity: retired, or never started. */
  retired: string[]
}

/** Seat file `seats/<name>.md`; a file moved to `seats/retired/` is not one. */
const seatFile = (root: string, name: string): string | undefined => {
  try {
    return fs.readFileSync(path.join(root, 'seats', `${name}.md`), 'utf8')
  } catch {
    return undefined
  }
}

const watchSeat = (root: string, name: string): WatchSeat => {
  const text = seatFile(root, name)
  const prefix = text === undefined ? undefined : parseSeat(name, text)?.prefix
  return prefix === undefined ? { name } : { name, prefix }
}

/**
 * The seats are the names a coordinator identity holds in the event log. The charter's book still
 * lists seats that retired, and the event-driven seats are not in it, so the book only names the
 * retired ones and, through its seat files, a seat's prefix.
 */
export function readSeatBook(root: string, charter: string, rows: readonly AgentEventRow[]): SeatBook {
  const live = liveCoordinators(rows)
  const running = new Set(live)
  return {
    live: live.map(name => watchSeat(root, name)),
    retired: charterSeats(charter).filter(name => isSeatName(name) && !running.has(name)),
  }
}

export const foldRoster = (rows: readonly AgentEventRow[]): AgentIdentity[] =>
  [...groupByAgent(rows).values()].flatMap(group => foldAgent(group) ?? [])

const INBOX_KINDS = "'message', 'broadcast', 'answer', 'decided'"
/** The seat's own rows that mark a turn: a send, or a tool call its hooks logged. */
const TURN_KINDS = "'message', 'broadcast', 'seat_activity'"
/** A packet carries at most this many unread messages, newest kept. */
const INBOX_LIMIT = 50

/** Messages to the seat since its own last turn row, oldest first. Throws when events.db cannot be read. */
export function readUnread(dbPath: string, seat: string): RawMessage[] {
  const db = openEvents(dbPath)
  try {
    const turn = db
      .prepare(`SELECT MAX(id) AS id FROM events WHERE actor = ? AND kind IN (${TURN_KINDS})`)
      .get(seat) as { id: number | null }
    const rows = db
      .prepare(
        `SELECT actor, kind, msg_id, ts, body FROM events WHERE target = ? AND kind IN (${INBOX_KINDS}) ` +
          'AND id > ? ORDER BY id DESC LIMIT ?',
      )
      .all(seat, turn.id ?? 0, INBOX_LIMIT) as unknown as MessageRow[]
    return rows
      .reverse()
      .map(r => ({ from: r.actor, kind: r.kind, msgId: r.msg_id, ts: r.ts, body: r.body ?? '' }))
  } finally {
    db.close()
  }
}

interface MessageRow {
  actor: string
  kind: string
  msg_id: string | null
  ts: number
  body: string | null
}

/** Epoch ms of each name's newest row as actor. Throws when events.db cannot be read. */
export function readActivity(dbPath: string, names: readonly string[]): Map<string, number> {
  if (names.length === 0) return new Map()
  const db = openEvents(dbPath)
  try {
    const marks = names.map(() => '?').join(',')
    const rows = db
      .prepare(`SELECT actor, MAX(ts) AS ts FROM events WHERE actor IN (${marks}) GROUP BY actor`)
      .all(...names) as unknown as { actor: string; ts: number }[]
    return new Map(rows.map(r => [r.actor, r.ts]))
  } finally {
    db.close()
  }
}

/**
 * Epoch ms of each sender's newest message to the seat since `sinceMs`. Any message counts as the
 * agent's last word: live, agents end on a `STOPPED` line as often as on the return contract.
 */
export function readLastWords(dbPath: string, seat: string, sinceMs: number): Map<string, number> {
  const db = openEvents(dbPath)
  try {
    const rows = db
      .prepare(
        "SELECT actor, MAX(ts) AS ts FROM events WHERE target = ? AND kind = 'message' AND ts >= ? GROUP BY actor",
      )
      .all(seat, sinceMs) as unknown as { actor: string; ts: number }[]
    return new Map(rows.map(r => [r.actor, r.ts]))
  } finally {
    db.close()
  }
}

interface StatusJson {
  implementers?: { active?: unknown; cap?: unknown } | null
  budget?: { stop?: unknown } | null
  stop?: unknown
}

const numberOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** `agent-chat seats status <seat> --json` as the packet's budget; a machine stop outranks the budget's. Throws on a failure body. */
export function parseSeatStatus(stdout: string): BudgetItem {
  const body = JSON.parse(stdout) as StatusJson & { error?: unknown }
  if (typeof body.error === 'string') throw new Error(body.error)
  const budgetStop = typeof body.budget?.stop === 'string' ? body.budget.stop : null
  return {
    implementers: numberOrNull(body.implementers?.active),
    cap: numberOrNull(body.implementers?.cap),
    stop: body.stop === 'machine' ? 'machine' : budgetStop,
  }
}

export const seatWatchFile = (dir: string, seat: string): string => path.join(dir, `${seat}.jsonl`)

/** The seat's newest row; undefined with no file. A torn last line falls back to the one before it. */
export function lastWatchRow(dir: string, seat: string): WatchRow | undefined {
  let text: string
  try {
    text = fs.readFileSync(seatWatchFile(dir, seat), 'utf8')
  } catch {
    return undefined
  }
  const lines = text.split('\n').filter(line => line.trim() !== '')
  for (const line of lines.reverse()) {
    try {
      return JSON.parse(line) as WatchRow
    } catch {
      continue
    }
  }
  return undefined
}

export function appendWatchRow(dir: string, row: WatchRow): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(seatWatchFile(dir, row.seat), `${JSON.stringify(row)}\n`)
}
