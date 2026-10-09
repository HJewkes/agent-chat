import fs from 'node:fs'
import { createRequire } from 'node:module'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import path from 'node:path'
import { BUSY_TIMEOUT_MS } from '../../broker/event-log.js'
import type { AgentEventRow } from '../../broker/event-store.js'
import { home } from '../../paths.js'
import type { EventKind } from '../../protocol.js'
import { activeWorkRoot } from '../active-work.js'
import { scoredPlanFromDisk } from '../burndown/score-render.js'
import { localDate } from '../burndown/seat-tick.js'
import type { HeartbeatMark } from './heartbeat.js'
import { watchedSeats, type Presence } from './liveness.js'
import type { OwnerMessage, SpendMeter } from './stops.js'
import type { PoolReading, SeatState } from './watchdog.js'

/** The watchdog's disk: autonomy files, the scorer, its own state, seat logs and events.db (read-only). */

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean; timeout?: number }) => DatabaseSyncType
}

/** Read-only and never migrated; waits out the broker's write lock like the broker's own connection does. */
export const openEvents = (dbPath: string): DatabaseSyncType =>
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

/** Undefined only when the path is missing; any other failure throws, so an unreadable journal never reads as an empty one. */
function ifPresent<T>(read: () => T): T | undefined {
  try {
    return read()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
}

/** The most rows the scorer is asked for; score.py's `--top 1000` the watchdog used to pass. */
const SCORER_TOP = 1000

/** The scorer's eligible count and the malformed tasks it skipped, so a count that fell from skips is told from a real drop. */
export interface Eligibility {
  count: number
  skipped: number
}

/** The scorer's eligibility for `seat`, or undefined when its policy or tasks cannot be read. */
export function scorerEligible(
  root: string,
  seat: string,
  opts: { activeWork?: string; today?: string } = {},
): Eligibility | undefined {
  try {
    const plan = scoredPlanFromDisk({
      seat,
      top: SCORER_TOP,
      today: opts.today ?? localDate(new Date()),
      autonomyRoot: root,
      activeWorkRoot: opts.activeWork ?? activeWorkRoot(),
    })
    return { count: plan.order.length, skipped: plan.skipped.length }
  } catch {
    return undefined
  }
}

/** A seat's watchdog state, its run spend meter, and whether its pool gate was closed at the last run. */
export type SeatRecord = SeatState & {
  run?: SpendMeter
  budgetPaused?: boolean
  capped?: boolean
  /** CC-320: the start of the dark episode the watchdog last tried to resume. */
  resumedDark?: number
  /** CC-326: tries at that episode while its resume is unconfirmed; absent once one was accepted. */
  resumeRetry?: number
  /** CC-326: when the watchdog first saw the seat absent with log row `register` as its last presence row. */
  absent?: { register: number; since: number }
  /** CC-463: epoch ms of the watchdog's last relaunch, saved before the launch call. */
  relaunchedAt?: number
  /** CC-463: relaunches since the seat last registered, counting the one at `relaunchedAt`. */
  relaunchTries?: number
  /** CC-402: the seat's agents already flagged as stuck in `spawning`, so each is logged once. */
  spawningFlagged?: string[]
  /** CC-862: the last heartbeat slot and pause reset the watchdog acted on. */
  heartbeat?: HeartbeatMark
}

/**
 * `seat-watchdog.json`. `stopped` is the owner's switch: a seat named there is
 * never woken or resumed, whatever else holds, until its entry is deleted.
 */
export interface WatchdogDoc {
  seats: Record<string, SeatRecord>
  pools: Record<string, SpendMeter>
  /** CC-409: each pool's last reading that held both windows. */
  lastReadings?: Record<string, PoolReading>
  stopped: Record<string, string>
  /** Whether a hold on every seat (restart window, unreadable events.db) was open at the last run. */
  held?: boolean
  /** Epoch ms of each pool's last failed probe; the pool is not probed again for an hour. */
  probeFailed?: Record<string, number>
  /** The attended seats seen so far, so a pass can say when one's file stops gating its spawns. */
  attended?: string[]
  /** CC-598, CC-693: the service cause each attended seat was last told; a seat absent was told of none. */
  serviceHeard?: Record<string, string>
}

const isCauseMap = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every(cause => typeof cause === 'string')

const emptyDoc = (): WatchdogDoc => ({ seats: {}, pools: {}, stopped: {} })

function parseStatusDoc(text: string, name: string): Partial<WatchdogDoc> {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (err) {
    throw new Error(`${name} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc))
    throw new Error(`${name} does not hold a JSON object`)
  return doc as Partial<WatchdogDoc>
}

/** An absent file is an empty doc. Throws, naming the file without its directory, when it cannot be read or parsed. */
export function readDoc(file = watchdogStatePath()): WatchdogDoc {
  const name = path.basename(file)
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return emptyDoc()
    throw new Error(`${name} cannot be read (${code ?? 'unknown error'})`)
  }
  const doc = parseStatusDoc(text, name)
  return {
    seats: doc.seats ?? {},
    pools: doc.pools ?? {},
    stopped: doc.stopped ?? {},
    ...(doc.lastReadings === undefined ? {} : { lastReadings: doc.lastReadings }),
    ...(doc.held === undefined ? {} : { held: doc.held }),
    ...(doc.probeFailed === undefined ? {} : { probeFailed: doc.probeFailed }),
    ...(Array.isArray(doc.attended) ? { attended: doc.attended } : {}),
    ...(isCauseMap(doc.serviceHeard) ? { serviceHeard: doc.serviceHeard } : {}),
  }
}

const isMap = (value: unknown): boolean =>
  value === undefined || (typeof value === 'object' && value !== null && !Array.isArray(value))

/** CC-326: a state file that cannot be read as written is an error, never "no stops". */
function parseDoc(text: string, file: string): Partial<WatchdogDoc> {
  const unusable = (why: string): Error =>
    new Error(
      `${path.basename(file)} is unusable (${why}), so the owner's stops are unknown; fix or delete it`,
    )
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch (err) {
    throw unusable(err instanceof Error ? err.message : String(err))
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw unusable('not a JSON object')
  const maps = doc as Record<'seats' | 'pools' | 'lastReadings' | 'stopped' | 'probeFailed', unknown>
  for (const key of ['seats', 'pools', 'lastReadings', 'stopped', 'probeFailed'] as const)
    if (!isMap(maps[key])) throw unusable(`\`${key}\` is not an object`)
  return doc as Partial<WatchdogDoc>
}

/** A missing file is a first run; one that is there and unreadable or unparsable throws. */
export function loadDoc(file = watchdogStatePath()): WatchdogDoc {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{}'
  const doc = parseDoc(text, file)
  return {
    seats: doc.seats ?? {},
    pools: doc.pools ?? {},
    stopped: doc.stopped ?? {},
    ...(doc.lastReadings === undefined ? {} : { lastReadings: doc.lastReadings }),
    ...(doc.held === undefined ? {} : { held: doc.held }),
    ...(doc.probeFailed === undefined ? {} : { probeFailed: doc.probeFailed }),
    ...(Array.isArray(doc.attended) ? { attended: doc.attended } : {}),
    ...(isCauseMap(doc.serviceHeard) ? { serviceHeard: doc.serviceHeard } : {}),
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

/** The names of the seat files under `root`; throws when `seats/` cannot be listed. */
export const seatFileNames = (root: string): string[] =>
  fs
    .readdirSync(path.join(root, 'seats'))
    .filter(file => file.endsWith('.md'))
    .map(file => file.slice(0, -'.md'.length))

const pad = (n: number): string => String(n).padStart(2, '0')

const localDay = (at: Date): string => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`

export const seatLogClock = (at: Date): string => `${pad(at.getHours())}:${pad(at.getMinutes())}`

export const seatLogPath = (root: string, seat: string, at: Date): string =>
  path.join(root, 'logs', seat, `${localDay(at)}.md`)

/** CC-326: a seat's journal for the local day of `at`; undefined when there is none, and throws when it cannot be read. */
export const readSeatJournal = (root: string, seat: string, at: Date): string | undefined =>
  ifPresent(() => fs.readFileSync(seatLogPath(root, seat, at), 'utf8'))

const JOURNAL_FILE = /^(\d{4})-(\d\d)-(\d\d)\.md$/

/** CC-326: local noon of each day the seat has a journal file for, newest first; throws when `logs/<seat>` cannot be listed. */
export function seatJournalDays(root: string, seat: string): Date[] {
  const names = ifPresent(() => fs.readdirSync(path.join(root, 'logs', seat))) ?? []
  return names
    .sort()
    .reverse()
    .flatMap(name => {
      const m = JOURNAL_FILE.exec(name)
      return m === null ? [] : [new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)]
    })
}

/** Charter section 10's format: local `logs/<seat>/<YYYY-MM-DD>.md`, each line led by local `HH:MM`. */
export function appendSeatLog(root: string, seat: string, at: Date, text: string): string {
  const file = seatLogPath(root, seat, at)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${seatLogClock(at)} ${text}\n`)
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

const maxId = (db: DatabaseSyncType, where: string, ...args: string[]): number => {
  const row = db.prepare(`SELECT MAX(id) AS id FROM events WHERE ${where}`).get(...args) as {
    id: number | null
  }
  return row.id ?? 0
}

const countAfter = (db: DatabaseSyncType, where: string, afterId: number, ...args: string[]): number => {
  const sql = `SELECT COUNT(*) AS n FROM events WHERE ${where} AND id > ?`
  return (db.prepare(sql).get(...args, afterId) as { n: number }).n
}

const REGISTERED = "actor = ? AND kind = 'registered'"
// CC-326: a handoff row alone is a teleport that may have been aborted; only the stand-down commits it.
const TELEPORT_ROWS = "actor = ? AND kind = 'agent_stood_down'"
const ANY_RESUME = "target = ? AND kind = 'agent_resumed'"
const WATCHDOG_RESUME =
  "target = ? AND kind = 'agent_resumed' AND json_extract(meta, '$.source') = 'watchdog'"
// CC-326: the supervisor closes the `agent_resumed` row of a launch that threw with this row.
const NEVER_STARTED = "actor = ? AND kind = 'agent_exited' AND json_extract(meta, '$.never_started') = 'true'"

/** Resume rows after log id `afterId` whose launch did not throw. */
const resumesLaunched = (db: DatabaseSyncType, seat: string, afterId: number): number =>
  countAfter(db, ANY_RESUME, afterId, seat) - countAfter(db, NEVER_STARTED, afterId, seat)

/** The watchdog's latest resume launched, and the seat's one register since is the session it started. */
function wokenByWatchdog(db: DatabaseSyncType, seat: string, registered: number): boolean {
  const woke = maxId(db, WATCHDOG_RESUME, seat)
  if (woke === 0 || countAfter(db, REGISTERED, woke, seat) !== 1) return false
  return countAfter(db, NEVER_STARTED, woke, seat) === countAfter(db, NEVER_STARTED, registered, seat)
}

// CC-463: an adopted session registered by itself, so its `agent_spawned` row is no launch.
const LAUNCH_ROWS =
  "target = ? AND kind IN ('agent_resumed', 'agent_spawned') AND COALESCE(json_extract(meta, '$.origin'), '') != 'adopted'"
const HANDOFF_ROWS = "actor = ? AND kind = 'agent_handoff'"

const tsOf = (db: DatabaseSyncType, id: number): number | undefined =>
  id === 0 ? undefined : (db.prepare('SELECT ts FROM events WHERE id = ?').get(id) as { ts: number }).ts

/** CC-463: the times the relaunch rule reads: last register, last launch, and a handoff no register followed. */
function relaunchTimes(db: DatabaseSyncType, seat: string, registered: number): Partial<Presence> {
  const handoff = maxId(db, HANDOFF_ROWS, seat)
  const times = {
    registeredAt: tsOf(db, registered),
    lastLaunchAt: tsOf(db, maxId(db, LAUNCH_ROWS, seat)),
    handoffAt: handoff > registered ? tsOf(db, handoff) : undefined,
  }
  return Object.fromEntries(Object.entries(times).filter(([, at]) => at !== undefined))
}

/** CC-320: a seat's latest presence rows. Throws when events.db cannot be read. */
export function readPresence(dbPath: string, seat: string): Presence {
  const db = openEvents(dbPath)
  try {
    const registered = maxId(db, REGISTERED, seat)
    const dark = db
      .prepare(
        "SELECT id, ts FROM events WHERE actor = ? AND kind = 'deregistered' AND id > ? ORDER BY id DESC LIMIT 1",
      )
      .get(seat, registered) as { id: number; ts: number } | undefined
    return {
      ...(dark === undefined ? {} : { darkSince: dark.ts }),
      ...(dark === undefined && registered > 0 ? { openRegister: registered } : {}),
      resumeStarted: resumesLaunched(db, seat, dark?.id ?? registered) > 0,
      teleported: countAfter(db, TELEPORT_ROWS, registered, seat) > 0,
      wokenByWatchdog: wokenByWatchdog(db, seat, registered),
      ...relaunchTimes(db, seat, registered),
    }
  } finally {
    db.close()
  }
}

/** CC-320: the broker's seat test, read fresh each call so a charter edit or an owner stop needs no restart. */
export function isWatchedSeat(name: string, root = defaultAutonomyRoot()): boolean {
  const charter = readText(path.join(root, 'charter.md'))
  if (charter === undefined) return false
  try {
    return watchedSeats(charter, loadDoc().stopped).includes(name)
  } catch {
    // CC-326: with the owner's stops unreadable nothing will resume the seat, so nothing is held for it.
    return false
  }
}
