import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSeatName, parseSeat } from './charter.js'
import {
  INBOX_TAIL,
  capText,
  readBootInbox,
  readLogSection,
  readQueueSections,
  readSeatDigest,
  readyNext,
  type BootInbox,
  type BootNext,
  type LogSection,
  type QueueSections,
  type ReadySource,
  type SeatDigest,
} from './boot-read.js'
import { inFlightLines, readInFlight, type InFlight, type InFlightPorts } from './in-flight-read.js'
import { readSeatFile } from './teleport-state.js'
import { plainError, poolReadingText, type HeartbeatStatus, type SeatStatus } from './status.js'

/**
 * CC-318: one boot digest for a coordinator seat, so a successor reads one command's output
 * instead of its seat file, queue, today's log, inbox and status one by one. Read-only.
 */

export const BOOT_CAP = 6_000

export interface BootDeps {
  now: () => Date
  autonomyRoot: string
  homeDir: string
  eventsDb: string
  /** Throws when the broker or the charter cannot answer; the boot keeps its other sections. */
  status: (seat: string) => Promise<SeatStatus>
  /** CC-934: the sources of the In flight section; each throws when it cannot answer. */
  inFlight: InFlightPorts
  /** CC-935: the seat's scored rows and tasks for the Next section; throws when the tasks cannot be read. */
  ready: (seat: string, now: Date) => Promise<ReadySource>
}

export interface SeatBoot {
  seat: string
  at: string
  seatFile: SeatDigest
  heartbeat: Pick<HeartbeatStatus, 'source' | 'cron'>
  queue: QueueSections
  /** CC-315: the absolute `scripts/seat/queue` path, or null where the install has no such file. */
  queueScript: string | null
  inFlight: InFlight
  next: BootNext
  log: LogSection
  inbox: BootInbox
  status: SeatStatus | { error: string }
}

/** Throws for a name that is not a seat slug and for a seat with no readable seat file. */
export async function seatBoot(deps: BootDeps, seat: string, after?: string): Promise<SeatBoot> {
  if (!isSeatName(seat)) throw new Error(`${seat} is not a seat name`)
  const plain = (err: unknown): string => plainError(err, [deps.autonomyRoot, deps.homeDir])
  const now = deps.now()
  const log = readLogSection(deps.autonomyRoot, seat, now)
  // CC-863: without --after, the State block's own cursor, so a successor never falls back to the last few.
  const cutoff = after ?? log.cursor ?? undefined
  let inbox: BootInbox
  try {
    inbox = readBootInbox(deps.eventsDb, seat, cutoff)
  } catch (err) {
    inbox = { after: cutoff ?? null, warning: null, messages: [], error: plain(err) }
  }
  let status: SeatBoot['status']
  try {
    status = await deps.status(seat)
  } catch (err) {
    status = { error: plain(err) }
  }
  const seatFile = readSeatDigest(deps.autonomyRoot, seat)
  return {
    seat,
    at: now.toISOString(),
    seatFile,
    heartbeat: seatHeartbeat(deps.autonomyRoot, seat),
    queue: readQueueSections(deps.autonomyRoot, seat),
    queueScript: queueScriptPath(),
    inFlight: await readInFlight(deps.inFlight, seat, seatFile.prefix, plain),
    next: await readNext(deps, seat, now, plain),
    log,
    inbox,
    status,
  }
}

/** Three levels up from `src/agents/seats/` and `dist/agents/seats/` alike is the package root. */
export function queueScriptPath(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const script = path.resolve(here, '..', '..', '..', 'scripts', 'seat', 'queue')
  return fs.existsSync(script) ? script : null
}

function seatHeartbeat(root: string, seat: string): SeatBoot['heartbeat'] {
  const file = readSeatFile(root, seat)
  const parsed = file === undefined ? undefined : parseSeat(seat, file)
  return { source: parsed?.heartbeatSource ?? 'cron', cron: parsed?.heartbeatCron ?? null }
}

/** `17,47 * * * *` reads as slots `17,47`; a cron that restricts the hour is shown whole. */
const cronSlots = (cron: string): string => {
  const [minute, hour, ...rest] = cron.trim().split(/\s+/)
  return minute !== undefined && hour === '*' && rest.every(f => f === '*') ? minute : cron
}

/** CC-391: who owns the seat's heartbeat, so a booting seat neither re-arms nor skips it. */
export function heartbeatLine({ source, cron }: SeatBoot['heartbeat']): string {
  const slots = cron === null ? undefined : cronSlots(cron)
  if (source === 'watchdog')
    return `Heartbeat: watchdog (${slots === undefined ? 'no heartbeat_cron' : `slots ${slots}`}; do not CronCreate)`
  return slots === undefined
    ? 'Heartbeat: cron (no heartbeat_cron in the seat file)'
    : `Heartbeat: cron ${slots} (CronCreate per charter §1.3)`
}

async function readNext(
  deps: BootDeps,
  seat: string,
  now: Date,
  plain: (err: unknown) => string,
): Promise<BootNext> {
  try {
    return { tasks: readyNext(await deps.ready(seat, now), now) }
  } catch (err) {
    return { tasks: [], error: plain(err) }
  }
}

function fieldText(value: unknown): string {
  if (Array.isArray(value)) return value.map(fieldText).join(', ')
  if (value !== null && typeof value === 'object')
    return Object.entries(value)
      .map(([k, v]) => `${k} ${fieldText(v)}`)
      .join(', ')
  return String(value)
}

function seatLines({ seat, seatFile, heartbeat }: SeatBoot): string[] {
  const { path, chars, mtime, fields } = seatFile
  return [
    `== seat ${seat}`,
    `file ${path} (${chars} chars, modified ${mtime}); its prose is not shown`,
    heartbeatLine(heartbeat),
    ...Object.entries(fields).map(([key, value]) => `${key}: ${fieldText(value)}`),
  ]
}

export const NEXT_SHOWN = 10
export const NEXT_TITLE = 60

const clip = (text: string, width: number): string =>
  text.length <= width ? text : `${text.slice(0, width - 1)}…`

/** CC-935: the seat's `brief:ready` tasks in CC-926's order, one line each, the first `NEXT_SHOWN` of them. */
function nextLines({ next }: SeatBoot): string[] {
  const head = '== next: brief:ready tasks, ranked'
  if (next.error !== undefined) return [head, 'unavailable: tasks']
  if (next.tasks.length === 0) return [head, 'next: none brief:ready']
  const more = next.tasks.length - NEXT_SHOWN
  return [
    head,
    ...next.tasks
      .slice(0, NEXT_SHOWN)
      .map(t => `${t.id}  p${t.priority}  ${t.ageDays}d  ${clip(t.title, NEXT_TITLE)}`),
    ...(more > 0 ? [`+${more} more`] : []),
  ]
}

const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`

/** CC-315: seats hand-edited queue files with heredocs; name the verbs where they look, with a runnable path. */
function queueEditLine({ seat, queue, queueScript: script }: SeatBoot): string[] {
  if (script === null) return []
  const root = path.dirname(path.dirname(queue.file))
  return [
    `edit: AUTONOMY_ROOT=${shellQuote(root)} ${shellQuote(script)} ${seat} replace|set|add|done|park|move  (never heredoc, Edit or sed -i)`,
  ]
}

function queueLines(boot: SeatBoot): string[] {
  const { queue } = boot
  const edit = queueEditLine(boot)
  if (!queue.found) return [`== queue: no queue file at ${queue.file}`, ...edit]
  return [`== queue ${queue.file}`, ...edit, ...(queue.next ?? '(no "## Next" section)').split('\n')]
}

function logLines(log: LogSection): string[] {
  if (!log.found) return [`== log: no log for today at ${log.file}`]
  if (log.section === null) return [`== log ${log.file}: no "## State at teleport" section`]
  return [`== log ${log.file}`, ...log.section.split('\n')]
}

function inboxLines(inbox: BootInbox, omitted: number): string[] {
  const head = `== inbox ${inbox.after === null ? `last ${INBOX_TAIL}` : `after ${inbox.after}`}`
  if (inbox.error !== undefined) return [head, `unavailable: ${inbox.error}`]
  const shown = inbox.messages.slice(omitted)
  const none =
    inbox.messages.length > 0
      ? []
      : [inbox.after !== null && inbox.warning === null ? `inbox: none after ${inbox.after}` : 'inbox: none']
  return [
    head,
    ...(inbox.warning === null ? [] : [`warning: ${inbox.warning}`]),
    ...(omitted === 0 ? [] : [`${omitted} earlier ${omitted === 1 ? 'message' : 'messages'} omitted`]),
    ...none,
    ...shown.map(m => `[${m.msgId}] from ${m.from}: ${m.text}`),
  ]
}

function statusLines({ status }: SeatBoot): string[] {
  if ('error' in status) return ['== status', `unavailable: ${status.error}`]
  const cap = (role: string, load: { active: number; cap: number }) => `${role} ${load.active}/${load.cap}`
  const { implementers, reviewers, planners, budget, inbox } = status
  const unread =
    inbox.error !== undefined
      ? `inbox unavailable: ${inbox.error}`
      : `inbox ${inbox.unread} unread since ${inbox.sinceLastSend ?? 'the start (the seat has sent nothing)'}`
  const caps =
    implementers === null ||
    reviewers === null ||
    planners === null ||
    status.other === null ||
    status.parked === null
      ? `agents unknown (${status.rosterUnknown})`
      : `caps ${[cap('implementers', implementers), cap('reviewers', reviewers), cap('planners', planners)].join(', ')}; other ${status.other.active}; parked ${status.parked.count}`
  return [
    '== status',
    caps,
    poolReadingText(status.budget),
    `stop ${budget.stop ?? `none; ${budget.margin}`}`,
    unread,
  ]
}

const size = (lines: string[]): number => lines.join('\n').length

type Block = 'seat' | 'queue' | 'inFlight' | 'next' | 'status'

const wholeBlocks = (boot: SeatBoot, homeDir: string): Record<Block, string[]> => ({
  seat: seatLines(boot),
  queue: queueLines(boot),
  inFlight: inFlightLines(boot.inFlight, homeDir),
  next: nextLines(boot),
  status: statusLines(boot),
})

/** CC-1471: the newest inbox messages a capped boot keeps until every other section is cut as far as it goes. */
export const INBOX_KEEP = 5

/**
 * Over the cap, the oldest inbox lines go first down to the newest INBOX_KEEP, then the log
 * section's tail, then whatever the queue, in-flight, next, seat and status still overrun by,
 * and only then the kept messages, oldest first.
 */
export function renderBoot(boot: SeatBoot, cap = BOOT_CAP, homeDir = ''): string[] {
  const whole = wholeBlocks(boot, homeDir)
  const cut: Partial<Record<Block, string[]>> = {}
  let log = boot.log
  let omitted = 0
  const render = (): string[] => [
    ...(cut.seat ?? whole.seat),
    ...(cut.inFlight ?? whole.inFlight),
    ...(cut.next ?? whole.next),
    ...(cut.queue ?? whole.queue),
    ...logLines(log),
    ...inboxLines(boot.inbox, omitted),
    ...(cut.status ?? whole.status),
  ]
  const over = (): number => size(render()) - cap
  const dropOldest = (upTo: number): void => {
    while (over() > 0 && omitted < upTo) omitted++
  }
  dropOldest(boot.inbox.messages.length - INBOX_KEEP)
  const section = log.section
  if (over() > 0 && section !== null)
    log = { ...log, section: capText(section, Math.max(0, section.length - over())) }
  for (const block of ['queue', 'inFlight', 'next', 'seat', 'status'] as const) {
    if (over() <= 0) break
    const text = whole[block].join('\n')
    cut[block] = capText(text, Math.max(0, text.length - over())).split('\n')
  }
  dropOldest(boot.inbox.messages.length)
  return render()
}
