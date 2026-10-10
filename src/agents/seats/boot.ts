import { isSeatName } from './charter.js'
import {
  INBOX_TAIL,
  capText,
  readBootInbox,
  readLogSection,
  readQueueSections,
  readSeatDigest,
  type BootInbox,
  type LogSection,
  type QueueSections,
  type SeatDigest,
} from './boot-read.js'
import { inFlightLines, readInFlight, type InFlight, type InFlightPorts } from './in-flight-read.js'
import { plainError, poolReadingText, type SeatStatus } from './status.js'

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
}

export interface SeatBoot {
  seat: string
  at: string
  seatFile: SeatDigest
  queue: QueueSections
  inFlight: InFlight
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
    queue: readQueueSections(deps.autonomyRoot, seat),
    inFlight: await readInFlight(deps.inFlight, seat, seatFile.prefix, plain),
    log,
    inbox,
    status,
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

function seatLines({ seat, seatFile }: SeatBoot): string[] {
  const { path, chars, mtime, fields } = seatFile
  return [
    `== seat ${seat}`,
    `file ${path} (${chars} chars, modified ${mtime}); its prose is not shown`,
    ...Object.entries(fields).map(([key, value]) => `${key}: ${fieldText(value)}`),
  ]
}

function queueLines({ queue }: SeatBoot): string[] {
  if (!queue.found) return [`== queue: no queue file at ${queue.file}`]
  return [`== queue ${queue.file}`, ...(queue.next ?? '(no "## Next" section)').split('\n')]
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
  return [
    '== status',
    `caps ${[cap('implementers', implementers), cap('reviewers', reviewers), cap('planners', planners)].join(', ')}; other ${status.other.active}; parked ${status.parked.count}`,
    poolReadingText(status.budget),
    `stop ${budget.stop ?? `none; ${budget.margin}`}`,
    unread,
  ]
}

const size = (lines: string[]): number => lines.join('\n').length

type Block = 'seat' | 'queue' | 'inFlight' | 'status'

/** Over the cap, the oldest inbox lines go first, then the log section's tail, then whatever the queue, seat and status still overrun by. */
export function renderBoot(boot: SeatBoot, cap = BOOT_CAP, homeDir = ''): string[] {
  const render = (log: LogSection, omitted: number, cut: Partial<Record<Block, string[]>> = {}): string[] => [
    ...(cut.seat ?? seatLines(boot)),
    ...(cut.inFlight ?? inFlightLines(boot.inFlight, homeDir)),
    ...(cut.queue ?? queueLines(boot)),
    ...logLines(log),
    ...inboxLines(boot.inbox, omitted),
    ...(cut.status ?? statusLines(boot)),
  ]
  let omitted = 0
  let lines = render(boot.log, omitted)
  while (size(lines) > cap && omitted < boot.inbox.messages.length) lines = render(boot.log, ++omitted)
  let log = boot.log
  const section = boot.log.section
  if (size(lines) > cap && section !== null) {
    log = { ...log, section: capText(section, Math.max(0, section.length - (size(lines) - cap))) }
    lines = render(log, omitted)
  }
  const cut: Partial<Record<Block, string[]>> = {}
  const whole: Record<Block, string[]> = {
    seat: seatLines(boot),
    queue: queueLines(boot),
    inFlight: inFlightLines(boot.inFlight, homeDir),
    status: statusLines(boot),
  }
  for (const block of ['queue', 'inFlight', 'seat', 'status'] as const) {
    const over = size(lines) - cap
    if (over <= 0) break
    const text = whole[block].join('\n')
    cut[block] = capText(text, Math.max(0, text.length - over)).split('\n')
    lines = render(log, omitted, cut)
  }
  return lines
}
