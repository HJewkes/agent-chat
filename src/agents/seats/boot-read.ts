import fs from 'node:fs'
import path from 'node:path'
import { localDay } from '../burndown/eligibility.js'
import type { PlannedRow } from '../burndown/plan-order.js'
import { frontmatter } from '../burndown/policy.js'
import { readyOrder } from '../burndown/ready-order.js'
import { parseIsoDay, type ScoredTask } from '../burndown/score.js'
import { parseTaskTags } from '../burndown/task-tags.js'
import { openEvents, readSeatJournal, readText, seatJournalDays, seatLogPath } from './io.js'

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
  /** The seat's name prefix, which the In flight section matches agents and branches on. */
  prefix?: string
  fields: Partial<Record<(typeof SEAT_KEYS)[number], unknown>>
}

/** Throws when the seat file cannot be read, since a boot for a seat with no file is a wrong name. */
export function readSeatDigest(root: string, seat: string): SeatDigest {
  const file = path.join(root, 'seats', `${seat}.md`)
  const text = fs.readFileSync(file, 'utf8')
  const all = frontmatter(text)
  const fields = Object.fromEntries(SEAT_KEYS.filter(k => all[k] !== undefined).map(k => [k, all[k]]))
  const prefix = typeof all.prefix === 'string' ? all.prefix : undefined
  return {
    path: file,
    chars: text.length,
    mtime: fs.statSync(file).mtime.toISOString(),
    ...(prefix === undefined ? {} : { prefix }),
    fields,
  }
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
  next: string | null
}

export function readQueueSections(root: string, seat: string): QueueSections {
  const file = path.join(root, 'queues', `${seat}.md`)
  const text = readText(file)
  if (text === undefined) return { file, found: false, next: null }
  const lines = text.split('\n')
  const pick = (heading: RegExp): string | null => {
    const at = lines.findIndex(line => heading.test(line))
    return at === -1 ? null : sectionFrom(lines, at, QUEUE_STOP)
  }
  // CC-934: the In flight section is derived (in-flight-read.ts), so it is not read from the file.
  return { file, found: true, next: pick(/^## Next\b/) }
}

export const LOG_CAP = 1_500

const TELEPORT_HEADING = /^## State at teleport (\d+)\b/

/** The line index and number of the highest-numbered `## State at teleport N` heading; the later one wins a tie. */
export function latestTeleportHeading(lines: string[]): { at: number; n: number } | undefined {
  let best: { at: number; n: number } | undefined
  lines.forEach((line, at) => {
    const n = Number(TELEPORT_HEADING.exec(line)?.[1] ?? NaN)
    if (Number.isFinite(n) && (best === undefined || n >= best.n)) best = { at, n }
  })
  return best
}

/** CC-863: the N of the log's highest `## State at teleport N`, or undefined when it has none. */
export const latestTeleportNumber = (log: string): number | undefined =>
  latestTeleportHeading(log.split('\n'))?.n

/** CC-863: ends the heading of a block agent-chat wrote, so it is never taken for the seat's own. */
export const GENERATED_MARK = '(agent-chat)'

/**
 * CC-863: seats write the cursor bare, after a clock, as a bullet, inside a `tick:` line, and with a
 * note after it (`(supersedes <id> above)`). A broker msg_id is 8 hex characters (`newMsgId`).
 */
const CURSOR = /\binbox handled through ([0-9a-f]{8})\b/gi
const CLOCK_LINE = /^(\d\d):(\d\d)\s/

export interface TeleportBlock {
  n: number
  /** The heading ends with `GENERATED_MARK`. */
  generated: boolean
  section: string
  /** The last msg_id the section names as handled, since a later line supersedes an earlier one. */
  cursor: string | undefined
  /** `HH:MM` of the nearest clock line above the heading, as minutes after midnight. */
  clockAbove: number | undefined
}

/** The last `inbox handled through <msg_id>` in `text`, in any of the forms seats write it. */
export const handledThrough = (text: string): string | undefined =>
  [...text.matchAll(CURSOR)].at(-1)?.[1]?.toLowerCase()

function clockAbove(lines: string[], at: number): number | undefined {
  for (let i = at - 1; i >= 0; i--) {
    const m = CLOCK_LINE.exec(lines[i] as string)
    if (m) return Number(m[1]) * 60 + Number(m[2])
  }
  return undefined
}

/** CC-863: the log's latest `State at teleport` block, read the one way teleport and `seats boot` both use. */
export function readTeleportBlock(log: string): TeleportBlock | undefined {
  const lines = log.split('\n')
  const best = latestTeleportHeading(lines)
  if (best === undefined) return undefined
  const section = sectionFrom(lines, best.at, QUEUE_STOP)
  return {
    n: best.n,
    generated: (lines[best.at] as string).trimEnd().endsWith(GENERATED_MARK),
    section,
    cursor: handledThrough(section),
    clockAbove: clockAbove(lines, best.at),
  }
}

/** The highest-numbered `## State at teleport N` section to the next heading; the later one wins a tie. */
export const latestTeleportState = (log: string): string | undefined => readTeleportBlock(log)?.section

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
  /** CC-863: the msg_id the section names as handled, which `seats boot` reads the inbox after by default. */
  cursor: string | null
}

export function readLogSection(root: string, seat: string, now: Date): LogSection {
  const file = seatLogPath(root, seat, now)
  const text = readText(file)
  const block = text === undefined ? undefined : readTeleportBlock(text)
  return {
    file,
    found: text !== undefined,
    section: block === undefined ? null : capText(block.section, LOG_CAP),
    cursor: block?.cursor ?? null,
  }
}

export const TELEPORT_LOOKBACK_DAYS = 7

export interface TeleportSection {
  /** Local `YYYY-MM-DD` of the journal the section came from. */
  day: string
  section: string
}

const DAY_MS = 86_400_000
const startOfDay = (at: Date): number => new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()
const dayName = (at: Date): string =>
  [at.getFullYear(), at.getMonth() + 1, at.getDate()].map(n => String(n).padStart(2, '0')).join('-')

/** The newest `State at teleport` section in a journal dated within the lookback of `now`, not only today's. */
export function latestTeleportSection(root: string, seat: string, now: Date): TeleportSection | undefined {
  const oldest = startOfDay(now) - TELEPORT_LOOKBACK_DAYS * DAY_MS
  for (const day of seatJournalDays(root, seat)) {
    if (startOfDay(day) < oldest) break
    const text = readSeatJournal(root, seat, day)
    const section = text === undefined ? undefined : latestTeleportState(text)
    if (section !== undefined) return { day: dayName(day), section }
  }
  return undefined
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

/** CC-935: the scorer's rows for a seat and the open tasks they came from. */
export interface ReadySource {
  order: readonly PlannedRow[]
  tasks: readonly ScoredTask[]
}

export interface NextTask {
  id: string
  initiative: string
  priority: number
  /** Whole days since the task's `brief:ready` day. */
  ageDays: number
  title: string
}

export interface BootNext {
  tasks: NextTask[]
  error?: string
}

/** CC-935: the rows whose task carries a valid `brief:ready=<day>`, in `readyOrder`'s order. */
export function readyNext(source: ReadySource, now: Date): NextTask[] {
  const tasks = new Map(source.tasks.map(t => [`${t.slug}/${t.id}`, t]))
  const taskOf = (row: PlannedRow) => tasks.get(`${row.initiative}/${row.id}`)
  const readyDay = (row: PlannedRow): number | undefined => {
    const task = taskOf(row)
    const day = task && parseTaskTags(task).task.briefReady
    return day === undefined ? undefined : parseIsoDay(day)
  }
  const ready = source.order.filter(row => readyDay(row) !== undefined)
  return readyOrder(ready, row => taskOf(row)?.priority).map(row => ({
    id: row.id,
    initiative: row.initiative,
    priority: taskOf(row)?.priority ?? Number.NaN,
    ageDays: localDay(now) - (readyDay(row) ?? Number.NaN),
    title: row.title,
  }))
}
