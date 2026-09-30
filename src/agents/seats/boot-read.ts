import fs from 'node:fs'
import path from 'node:path'
import { frontmatter } from '../burndown/policy.js'
import { openEvents, readText, seatLogPath } from './io.js'

/** CC-318: the readers behind `seats boot`, each read-only. */

/** The seat file's frontmatter keys a successor needs; its prose is only pointed at. */
export const SEAT_KEYS = [
  'name',
  'pool',
  'config_dir',
  'concurrency',
  'spend',
  'scope_tags',
  'excluded_tags',
  'grants_extra',
] as const

export interface SeatDigest {
  path: string
  chars: number
  mtime: string
  fields: Partial<Record<(typeof SEAT_KEYS)[number], unknown>>
}

/** Throws when the seat file cannot be read, since a boot for a seat with no file is a wrong name. */
export function readSeatDigest(root: string, seat: string): SeatDigest {
  const file = path.join(root, 'seats', `${seat}.md`)
  const text = fs.readFileSync(file, 'utf8')
  const all = frontmatter(text)
  const fields = Object.fromEntries(SEAT_KEYS.filter(k => all[k] !== undefined).map(k => [k, all[k]]))
  return { path: file, chars: text.length, mtime: fs.statSync(file).mtime.toISOString(), fields }
}

/** From the line matching `start` to the next line matching `stop`, or the end; trailing blank lines dropped. */
function sectionFrom(lines: string[], at: number, stop: RegExp): string {
  const end = lines.findIndex((line, i) => i > at && stop.test(line))
  return lines
    .slice(at, end === -1 ? undefined : end)
    .join('\n')
    .trimEnd()
}

// A queue section keeps its `###` subsections; only a `#` or `##` heading ends it.
const QUEUE_STOP = /^#{1,2}\s/

export interface QueueSections {
  file: string
  found: boolean
  inFlight: string | null
  next: string | null
}

export function readQueueSections(root: string, seat: string): QueueSections {
  const file = path.join(root, 'queues', `${seat}.md`)
  const text = readText(file)
  if (text === undefined) return { file, found: false, inFlight: null, next: null }
  const lines = text.split('\n')
  const pick = (heading: RegExp): string | null => {
    const at = lines.findIndex(line => heading.test(line))
    return at === -1 ? null : sectionFrom(lines, at, QUEUE_STOP)
  }
  return { file, found: true, inFlight: pick(/^## In flight\b/), next: pick(/^## Next\b/) }
}

export const LOG_CAP = 1_500

const TELEPORT_HEADING = /^## State at teleport (\d+)\b/

/** The highest-numbered `## State at teleport N` section to the next heading; the later one wins a tie. */
export function latestTeleportState(log: string): string | undefined {
  const lines = log.split('\n')
  let best: { at: number; n: number } | undefined
  lines.forEach((line, at) => {
    const n = Number(TELEPORT_HEADING.exec(line)?.[1] ?? NaN)
    if (Number.isFinite(n) && (best === undefined || n >= best.n)) best = { at, n }
  })
  return best === undefined ? undefined : sectionFrom(lines, best.at, QUEUE_STOP)
}

/** `text` cut to at most `cap` characters at a line end where one exists, with a note on what was cut. */
export function capText(text: string, cap: number): string {
  if (text.length <= cap) return text
  const note = `[cut at ${cap} of ${text.length} chars]`
  const room = Math.max(0, cap - note.length - 1)
  const head = text.slice(0, room)
  const lineEnd = head.lastIndexOf('\n')
  const kept = lineEnd > 0 ? head.slice(0, lineEnd) : head
  return kept === '' ? note : `${kept}\n${note}`
}

export interface LogSection {
  file: string
  found: boolean
  section: string | null
}

export function readLogSection(root: string, seat: string, now: Date): LogSection {
  const file = seatLogPath(root, seat, now)
  const text = readText(file)
  const section = text === undefined ? undefined : latestTeleportState(text)
  return {
    file,
    found: text !== undefined,
    section: section === undefined ? null : capText(section, LOG_CAP),
  }
}

export const INBOX_TAIL = 5
export const INBOX_TEXT = 240

export interface BootMessage {
  msgId: string
  from: string
  text: string
}

export interface BootInbox {
  after: string | null
  /** Set when `after` names no event, so the last few messages stand in. */
  warning: string | null
  messages: BootMessage[]
  error?: string
}

const INBOX_KINDS = "'message', 'broadcast', 'answer', 'decided'"

interface MessageRow {
  msg_id: string | null
  actor: string
  body: string | null
}

const toMessage = (row: MessageRow): BootMessage => ({
  msgId: row.msg_id ?? '?',
  from: row.actor,
  text: (row.body ?? '').replace(/\s+/g, ' ').trim().slice(0, INBOX_TEXT),
})

type Db = ReturnType<typeof openEvents>

function messagesAfter(db: Db, seat: string, afterId: number): BootMessage[] {
  const sql = `SELECT msg_id, actor, body FROM events WHERE target = ? AND kind IN (${INBOX_KINDS}) AND id > ? ORDER BY id`
  return (db.prepare(sql).all(seat, afterId) as unknown as MessageRow[]).map(toMessage)
}

function lastMessages(db: Db, seat: string): BootMessage[] {
  const sql = `SELECT msg_id, actor, body FROM events WHERE target = ? AND kind IN (${INBOX_KINDS}) ORDER BY id DESC LIMIT ?`
  return (db.prepare(sql).all(seat, INBOX_TAIL) as unknown as MessageRow[]).map(toMessage).reverse()
}

/** Messages to `seat` after the event carrying `after`, oldest first; the last few without one. Throws when events.db cannot be read. */
export function readBootInbox(dbPath: string, seat: string, after: string | undefined): BootInbox {
  const db = openEvents(dbPath)
  try {
    if (after === undefined) return { after: null, warning: null, messages: lastMessages(db, seat) }
    const cutoff = db.prepare('SELECT MIN(id) AS id FROM events WHERE msg_id = ?').get(after) as {
      id: number | null
    }
    if (cutoff.id === null) {
      const warning = `unknown msg_id ${after}; showing the last ${INBOX_TAIL}`
      return { after, warning, messages: lastMessages(db, seat) }
    }
    return { after, warning: null, messages: messagesAfter(db, seat, cutoff.id) }
  } finally {
    db.close()
  }
}
