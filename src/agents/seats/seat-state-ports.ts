import os from 'node:os'
import path from 'node:path'
import { emptySeatState, type SeatState } from '@titan-design/coordinator'
import type { Claim as LiveClaim } from '../../broker/claims.js'
import type { EventStore } from '../../broker/event-store.js'
import type { AgentIdentity } from '../../protocol.js'
import { home, burndownLedgerPath } from '../../paths.js'
import type { ShepherdRow } from '../../shepherd-client.js'
import { INBOX_TAIL, INBOX_TEXT, capText, type BootInbox, type BootMessage } from './boot-read.js'
import { parseSeat } from './charter.js'
import { readDispatches } from './dispatch-read.js'
import type { DispatchRecord } from './dispatch-record.js'
import {
  claimsPort,
  eventsVerdictsPort,
  parseShepherdFlights,
  readInFlight,
  type InFlightPorts,
} from './in-flight-read.js'
import { readPace, type PaceRead } from './pace-file.js'
import { lastTeleportAt, readSeatState } from './seat-event-log.js'
import { renderSeatState, type Readable, type WorktreeClaim } from './seat-state-render.js'
import { plainError } from './status.js'
import { readSeatFile } from './teleport-state.js'

/**
 * TP-1600 e: what the broker reads at a seat's teleport to compose its successor's state section.
 * Every source answers within `SEAT_PORT_MS` or reads as an `unavailable:` line; none fails the teleport.
 */

export const SEAT_PORT_MS = 5_000
export const INBOX_CAP = 3_000
const INBOX_LIMIT = 50

export interface SeatStateSources {
  inFlight: InFlightPorts
  pace: () => Promise<PaceRead>
  /** Dispatch outcomes at or after `since`, an ISO time. */
  recent: (since: string) => Promise<DispatchRecord[]>
  /** Messages after `after`; the last few when it is undefined or unknown. */
  inbox: (after: string | undefined) => Promise<BootInbox>
  /** The worktree claims the broker holds for the seat across the teleport window (CC-397). */
  worktreeClaims: () => Promise<WorktreeClaim[]>
}

export interface SeatStateCompose {
  root: string
  seat: string
  inboxAfter: string | undefined
  /** The cursor the seat's State block should have named but did not, so the inbox is only its tail. */
  cursorMissing?: boolean
  /** Where Recent starts when the seat log names no earlier teleport: the predecessor's session start. */
  sessionStart: string
  now: number
  tmpdir?: string
  homeDir?: string
  portMs?: number
}

/** Rejects with a plain reason once `ms` passes, so a hung source costs its own line and nothing else. */
export function withDeadline<T>(read: () => Promise<T>, source: string, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${source} did not answer in ${ms} ms`)), ms)
  })
  return Promise.race([Promise.resolve().then(read), deadline]).finally(() => clearTimeout(timer))
}

async function settle<T>(read: Promise<T>, plain: (err: unknown) => string): Promise<Readable<T>> {
  try {
    return await read
  } catch (err) {
    return { unavailable: plain(err) }
  }
}

const isUnavailable = <T>(v: Readable<T>): v is { unavailable: string } =>
  typeof v === 'object' && v !== null && 'unavailable' in v

function deadlinePorts(ports: InFlightPorts, ms: number): InFlightPorts {
  return {
    roster: () => withDeadline(ports.roster, 'roster', ms),
    shepherd: () => withDeadline(ports.shepherd, 'shepherd', ms),
    verdicts: () => withDeadline(ports.verdicts, 'verdicts', ms),
    claims: () => withDeadline(ports.claims, 'claims', ms),
  }
}

interface SeatLogRead {
  state: SeatState
  since: string
  notes: string[]
}

function seatLog(input: SeatStateCompose, plain: (err: unknown) => string): SeatLogRead {
  try {
    const opts = { tmpdir: input.tmpdir ?? os.tmpdir() }
    const read = readSeatState(input.root, input.seat, opts)
    const since = lastTeleportAt(input.root, input.seat) ?? input.sessionStart
    const corrupt =
      read.corruptLines === 0 ? [] : [`${read.corruptLines} unreadable lines in seat-events.jsonl skipped`]
    return { state: read.state, since, notes: corrupt }
  } catch (err) {
    const notes = [`unavailable: seat event log (${plain(err)})`]
    return { state: emptySeatState(), since: input.sessionStart, notes }
  }
}

const messageLine = (m: BootMessage): string => `${m.msgId} ${m.from}: ${m.text}`

function inboxHead(input: SeatStateCompose, inbox: BootInbox): string {
  if (input.cursorMissing)
    return `== inbox (the State block names no cursor: the last ${INBOX_TAIL} messages, oldest first)`
  if (inbox.after === null) return `== inbox (no cursor: the last ${INBOX_TAIL} messages, oldest first)`
  return `== inbox after ${inbox.after} (oldest first)`
}

/** The inbox after the cutoff, capped: the successor reads it here instead of re-reading the bus. */
export function inboxLines(input: SeatStateCompose, inbox: Readable<BootInbox>): string[] {
  if (isUnavailable(inbox))
    return [`== inbox after ${input.inboxAfter ?? 'none'}`, `unavailable: inbox (${inbox.unavailable})`]
  const body = [
    ...(inbox.warning === null ? [] : [`warning: ${inbox.warning}`]),
    ...(inbox.messages.length === 0 ? ['inbox: none'] : inbox.messages.map(messageLine)),
  ]
  return [inboxHead(input, inbox), ...capText(body.join('\n'), INBOX_CAP).split('\n')]
}

/** The successor's state and inbox sections. Never throws: a source that fails reads as `unavailable:`. */
export async function composeSeatState(
  sources: SeatStateSources,
  input: SeatStateCompose,
): Promise<string[]> {
  const ms = input.portMs ?? SEAT_PORT_MS
  const homeDir = input.homeDir ?? os.homedir()
  const plain = (err: unknown): string => plainError(err, [input.root, homeDir])
  const { state, since, notes } = seatLog(input, plain)
  const prefix = seatPrefix(input.root, input.seat)
  const [inFlight, pace, recent, claims, inbox] = await Promise.all([
    readInFlight(deadlinePorts(sources.inFlight, ms), input.seat, prefix, plain),
    settle(withDeadline(sources.pace, 'budget', ms), plain),
    settle(
      withDeadline(() => sources.recent(since), 'recent', ms),
      plain,
    ),
    settle(withDeadline(sources.worktreeClaims, 'worktree claims', ms), plain),
    settle(
      withDeadline(() => sources.inbox(input.inboxAfter), 'inbox', ms),
      plain,
    ),
  ])
  const rendered = renderSeatState({
    state,
    inFlight,
    worktreeClaims: isUnavailable(claims) ? state.claims : claims,
    pace: isUnavailable(pace) ? { found: false, reason: pace.unavailable } : pace,
    recent,
    now: input.now,
    homeDir,
  })
  const claimNote = isUnavailable(claims) ? [`unavailable: worktree claims (${claims.unavailable})`] : []
  return [...rendered, ...claimNote, ...notes, ...inboxLines(input, inbox)]
}

function seatPrefix(root: string, seat: string): string | undefined {
  const file = readSeatFile(root, seat)
  return file === undefined ? undefined : parseSeat(seat, file)?.prefix
}

export interface BrokerSeatReads {
  roster: () => AgentIdentity[]
  events: Pick<EventStore, 'inboxFor' | 'inboxRowId' | 'inboxSince'>
  liveClaims: () => LiveClaim[]
  /** The teleport's own Shepherd read, shared so the State block and In flight run one subprocess. */
  shepherd: () => Promise<ShepherdRow[] | undefined>
}

const toBootMessage = ({ msgId, from, text }: BootMessage): BootMessage => ({
  msgId,
  from,
  text: text.replace(/\s+/g, ' ').trim().slice(0, INBOX_TEXT),
})

/** The broker's own event store, so the inbox read needs no second handle on events.db. */
function brokerInbox(events: BrokerSeatReads['events'], seat: string, after: string | undefined): BootInbox {
  const tail = (): BootMessage[] => events.inboxFor(seat, INBOX_TAIL).map(toBootMessage)
  if (after === undefined) return { after: null, warning: null, messages: tail() }
  const id = events.inboxRowId(seat, after)
  if (id === undefined)
    return { after, warning: `unknown msg_id ${after}; showing the last ${INBOX_TAIL}`, messages: tail() }
  return { after, warning: null, messages: events.inboxSince(seat, id, INBOX_LIMIT).map(toBootMessage) }
}

const claimOf = (c: LiveClaim): WorktreeClaim => ({
  owner: c.owner,
  worktree: c.worktreePath,
  patterns: c.patterns,
})

/** The sources inside the broker: its roster, claims and event store, Shepherd, the pace file and the dispatch log. */
export function brokerSeatStateSources(root: string, seat: string, reads: BrokerSeatReads): SeatStateSources {
  return {
    inFlight: {
      roster: async () => reads.roster(),
      shepherd: async () => {
        const rows = await reads.shepherd()
        if (rows === undefined) throw new Error('shepherd status did not answer')
        return parseShepherdFlights(JSON.stringify(rows))
      },
      verdicts: eventsVerdictsPort(path.join(home(), 'events.db')),
      claims: claimsPort(burndownLedgerPath()),
    },
    pace: async () => readPace(),
    recent: async since => readDispatches(root, seat, since).records,
    inbox: async after => brokerInbox(reads.events, seat, after),
    worktreeClaims: async () =>
      reads
        .liveClaims()
        .filter(c => c.owner === seat)
        .map(claimOf),
  }
}
