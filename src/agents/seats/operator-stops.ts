import type { MachineStop, MachineStopReadings } from './stops.js'
import { HEADROOM_RESOURCES, HEADROOM_SHORT_LABELS, type HeadroomReadings } from '../host-headroom.js'

/**
 * CC-957: every stop an operator or the owner has put on the machine, in one document, so a
 * consumer outside the bus (Shepherd's machine-stop watch, TP-1749) reads state instead of
 * parsing chat. Pure: the verb reads events.db, the stop file and seat-watchdog.json and passes them in.
 */

/** A broadcast HOLD with no lift is dropped after this, so a lost lift cannot stop the machine for good. */
export const BROADCAST_HOLD_MAX_MS = 24 * 3_600_000

const REASON_MAX = 200

export interface ChatLine {
  ts: number
  actor: string
  msgId: string | null
  body: string
  /** Sent with chat_broadcast. */
  broadcast: boolean
  /** The seats the send went to. */
  targets: readonly string[]
  /**
   * The seats the sender named, from broker.log's route row; absent when that row is gone. A fan-out
   * that reached one seat logs one events.db row, so only this tells it from a DM.
   */
  addressed?: readonly string[]
}

export interface OperatorHold {
  kind: 'broadcast' | 'file'
  by: string
  /** ISO time the hold began. */
  since: string
  reason: string
  /** The message that opened a broadcast hold. */
  msgId?: string
  /** A fan-out hold's seats not yet lifted by DM; absent for a broadcast hold, which no DM lifts. */
  seats?: string[]
}

export interface OwnerStop {
  seat: string
  reason: string
}

export interface MachineStopStatus {
  at: string
  /** True when an operator hold or the machine stop applies, or a source could not be read. Owner stops hold one seat each, so they do not count. */
  stopped: boolean
  holds: OperatorHold[]
  ownerStops: OwnerStop[]
  machine: MachineStopReadings & { stop: string | null }
  /** Sources that could not be read; each one counts as a stop, as the watchdog holds on an unreadable events.db. */
  errors: string[]
}

/** A message's head: its first sentence on its first line, where every observed stop and lift is stated. */
const HEAD_MAX = 160
const SENTENCE_END = /[.!?;](?:\s|$)/
export function messageHead(body: string): string {
  const first = body.trimStart().split('\n')[0] ?? ''
  const end = first.search(SENTENCE_END)
  return (end === -1 ? first : first.slice(0, end)).slice(0, HEAD_MAX)
}

/** "LIFT yet?", "is the hold LIFTED?": a first sentence that asks changes nothing. */
function asks(body: string): boolean {
  const first = body.trimStart().split('\n')[0] ?? ''
  const end = first.search(SENTENCE_END)
  return end !== -1 && first[end] === '?'
}

/**
 * Who may hold the machine from chat (CC-957 review): one of the configured operators, sending to
 * the machine (a broadcast, or a fan-out to two or more seats). A coordinator's relay, ack or question
 * never reaches the classifier, and an operator's DM HOLD stops only its one seat.
 */
export function machineScoped(line: ChatLine, operators: readonly string[]): boolean {
  const named = Math.max(line.targets.length, line.addressed?.length ?? 0)
  return operators.includes(line.actor) && (line.broadcast || named >= 2)
}

/**
 * The operator's stop vocabulary, upper case as it is sent. Every one of these in a head opens a hold
 * unless the words right beside that occurrence say it refers to a hold or names one target; only a
 * head that starts with a lift form lifts.
 */
const STOP_WORD = /\bHOLD\b|\bMACHINE STOP\b|\bSTOP[ -]ALL\b|\bSTEP-BACK\b|\bREBOOT (?:NOTICE|QUIET)\b/
const STOP_WORDS = new RegExp(STOP_WORD.source, 'g')
/** A cited message id: 8 hex digits with at least one letter, so a date or time is never one. */
const MESSAGE_ID = String.raw`(?=\d*[a-f])[0-9a-f]{8}\b`
/** One piece of work: "#187", "CC-763". */
const TARGET = String.raw`(?:#\d+|\b[A-Z]{2,5}-\d+)\b`
/** Words just before a stop word that refer to a hold: "ACK HOLD", "Re HOLD", "under your 08:59 HOLD", "not a HOLD", "the MACHINE STOP gate". */
const REFERS_BEFORE =
  /(?:^|[^\w-])(?:(?:ack(?:ed)?|re)\s+|(?:no|not\s+a|my|your|the|still\s+in|during\s+a|under)\s+(?:[\w-]+(?::\w+)?\s+)?)$/i
/**
 * Words just after a stop word that refer to a hold, or name its one target or the message that opened
 * it. Case-sensitive, so "load-5" is never read as a task id.
 */
const REFERS_AFTER = new RegExp(
  String.raw`^\s+(?:(?:ack(?:ed|nowledged)?|ACK(?:ED)?|stays|still|covers|applies)\b|(?:on\s+|dispatch\s+of\s+)?${TARGET}|${MESSAGE_ID})`,
)

function opensAHold(head: string): boolean {
  for (const stop of head.matchAll(STOP_WORDS)) {
    const before = head.slice(0, stop.index)
    const after = head.slice(stop.index + stop[0].length)
    if (!REFERS_BEFORE.test(before) && !REFERS_AFTER.test(after)) return true
  }
  return false
}

/** "LIFT at NORMAL pace", "LOAD CLEAR 22:34", "ALL-CLEAR"; never "NO CLEAR" or "NOT CLEAR". */
const LIFT_LEAD = /^(?:LIFT\b|(?!(?:NO|NOT)\b)(?:[A-Z]+[ -])?CLEAR\b)/
/** "build hold LIFTED", "STOP ALL and the build hold are LIFTED", "REBOOT QUIET RELEASED 13:39". */
const HOLD_ENDED = /^((?:[\w-]+\s+){0,5}?)(?:hold|stop|quiet)s?\s+(?:(?:is|are)\s+)?(lifted|released)\b/i
/** A hold that is not the machine's, or a lift still to come: "until the HOLD is LIFTED", "the restart hold". */
const NOT_THIS_LIFT = /\b(?:until|once|for|when|after|before|if|no|not|restart)\b/i

/** A lift is a head that starts with a lift form, so a lift form later in it ("parked until LIFT") never lifts. */
function liftsTheHold(head: string): boolean {
  if (new RegExp(TARGET).test(head)) return false
  if (LIFT_LEAD.test(head)) return true
  const ended = HOLD_ENDED.exec(head)
  if (ended === null) return false
  const [, subject = '', verb = ''] = ended
  return verb === verb.toUpperCase() && !NOT_THIS_LIFT.test(subject)
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The head without its sender, as messages open: "tp-operator: ", "tp-ram (successor of tp-ram-1003): ",
 * "tp-operator 22:4x: ". Only the message's real actor is removed, so "No LIFT yet" keeps its "No".
 */
export function headAfterSender(body: string, actor: string): string {
  const sender = new RegExp(String.raw`^${escapeRegExp(actor)}(?:\s*\([^)]*\))?(?:\s+\d\d:\d[\dx])?[:,]?\s+`)
  return messageHead(body).replace(sender, '')
}

export type Classified = 'open' | 'lift' | 'none'

export function classify(body: string, actor: string): Classified {
  const head = headAfterSender(body, actor)
  if (liftsTheHold(head)) return asks(body) ? 'none' : 'lift'
  return opensAHold(head) ? 'open' : 'none'
}

const firstLine = (text: string): string => (text.split('\n')[0] ?? '').trim().slice(0, REASON_MAX)

/** The text after the stop word, which is where every observed HOLD states its cause. */
function holdReason(body: string): string {
  const stop = STOP_WORD.exec(body)
  if (stop === null) return firstLine(body)
  const after = body.slice(stop.index + stop[0].length).replace(/^\s*[:,.]?\s*/, '')
  return firstLine(after) || firstLine(body)
}

interface OpenHold {
  first: ChatLine
  latestMs: number
  /** The fan-out's seats not yet lifted, or 'all' for a broadcast hold. */
  seats: Set<string> | 'all'
}

interface HoldState {
  open: Map<string, OpenHold>
  /** When each seat's open operator DM HOLD was sent; it stops that seat only, never the machine. */
  seatHolds: Map<string, number>
}

function addHold({ open }: HoldState, line: ChatLine): void {
  const held = open.get(line.actor)
  const seats =
    line.broadcast || held?.seats === 'all' ? 'all' : new Set([...(held?.seats ?? []), ...line.targets])
  open.set(line.actor, { first: held?.first ?? line, latestMs: line.ts, seats })
}

/** The newest open fan-out hold time covering `seat`, or -1. */
function newestFanOut(open: Map<string, OpenHold>, seat: string): number {
  let newest = -1
  for (const { seats, latestMs } of open.values())
    if (seats !== 'all' && seats.has(seat)) newest = Math.max(newest, latestMs)
  return newest
}

/**
 * A DM lift answers the newest hold on its seat: a DM HOLD sent after the fan-out is lifted alone,
 * and otherwise the seat leaves every open fan-out hold.
 */
function liftSeat({ open, seatHolds }: HoldState, seat: string): void {
  const seatHold = seatHolds.get(seat)
  seatHolds.delete(seat)
  if (seatHold !== undefined && seatHold > newestFanOut(open, seat)) return
  for (const [actor, { seats }] of open) {
    if (seats === 'all' || !seats.delete(seat)) continue
    if (seats.size === 0) open.delete(actor)
  }
}

/**
 * The operator opens a hold with one fan-out and often lifts it with one DM per seat. A DM lift ends
 * that seat's part of the newest hold on it, and a hold ends when its last seat is lifted; a
 * machine-scoped lift (a broadcast, or a fan-out to two or more seats) ends every hold. A DM never
 * ends a broadcast hold. Leaving the bus never ends a seat's part, since its absence is what a hold
 * is for; a lift, the cap, or the seat being stopped or having no seat file at read time does (CC-971).
 */
function liftHolds(state: HoldState, line: ChatLine, operators: readonly string[]): void {
  if (!machineScoped(line, operators)) {
    for (const seat of line.targets) liftSeat(state, seat)
    return
  }
  state.open.clear()
  state.seatHolds.clear()
}

function applySend(state: HoldState, line: ChatLine, operators: readonly string[]): void {
  const kind = classify(line.body, line.actor)
  if (kind === 'lift') liftHolds(state, line, operators)
  else if (kind === 'open' && machineScoped(line, operators)) addHold(state, line)
  else if (kind === 'open') for (const seat of line.targets) state.seatHolds.set(seat, line.ts)
}

/**
 * Active broadcast HOLDs, one per operator, each dated from that operator's first stop since the last
 * lift. A machine-scoped operator send opens a hold; any operator send, DM included, may lift, and
 * a lift from any operator counts: the hold is the machine's. The cap runs from the operator's latest
 * stop, so a HOLD sent again stands a full cap past the repeat; the reader reads one cap back, so
 * `since` is then the oldest stop within it.
 */
export function broadcastHolds(
  lines: readonly ChatLine[],
  nowMs: number,
  operators: readonly string[],
  gone: (seat: string) => boolean = () => false,
): OperatorHold[] {
  const state: HoldState = { open: new Map(), seatHolds: new Map() }
  const sorted = lines
    .filter(line => line.ts <= nowMs && operators.includes(line.actor))
    .sort((a, b) => a.ts - b.ts)
  for (const line of sorted) applySend(state, line, operators)
  return [...state.open.values()]
    .filter(({ latestMs }) => nowMs - latestMs <= BROADCAST_HOLD_MAX_MS)
    .flatMap(hold => withoutGoneSeats(hold, gone) ?? [])
    .map(({ first, seats }) => ({
      kind: 'broadcast' as const,
      by: first.actor,
      since: new Date(first.ts).toISOString(),
      reason: holdReason(first.body.trimStart()),
      ...(first.msgId === null ? {} : { msgId: first.msgId }),
      ...(seats === 'all' ? {} : { seats: [...seats].sort() }),
    }))
}

/**
 * A fan-out hold without the seats that are gone at read time, or undefined when none is left.
 * Only the end state is filtered: the stopped map and seat files are known at read time alone.
 */
function withoutGoneSeats(hold: OpenHold, gone: (seat: string) => boolean): OpenHold | undefined {
  if (hold.seats === 'all') return hold
  const seats = new Set([...hold.seats].filter(seat => !gone(seat)))
  return seats.size === 0 ? undefined : { ...hold, seats }
}

/** The stop file's hold, or an error naming what is wrong with it; an absent file is undefined. */
export function fileHold(text: string | undefined): OperatorHold | { error: string } | undefined {
  if (text === undefined) return undefined
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return { error: 'the stop file is not JSON' }
  }
  const { by, since, reason } = (doc ?? {}) as Record<string, unknown>
  if (typeof by !== 'string' || typeof since !== 'string' || typeof reason !== 'string')
    return { error: 'the stop file needs string fields by, since and reason' }
  if (!Number.isFinite(Date.parse(since))) return { error: 'the stop file since is not an ISO time' }
  return { kind: 'file', by, since, reason }
}

export interface StopInputs {
  now: Date
  /** Undefined when events.db could not be read. */
  chat: readonly ChatLine[] | undefined
  /** The agents whose machine-wide sends open and lift a chat HOLD. */
  operators: readonly string[]
  /** The stop file's text; undefined when it does not exist. */
  stopFile: () => string | undefined
  /** seat-watchdog.json's `stopped` map; throws when the file cannot be read. */
  ownerStops: () => Record<string, string>
  /** The seat file names; throws when they cannot be listed. */
  seatNames: () => string[]
  readings: MachineStopReadings
  machineStop: MachineStop | null
}

function tryRead<T>(read: () => T, errors: string[], source: string): T | undefined {
  try {
    return read()
  } catch (err) {
    errors.push(`${source}: ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}

/**
 * A seat whose fan-out part no longer counts: owner-stopped, or with no seat file. Seat files that
 * cannot be listed drop nothing and add no error, so a host without an autonomy root never clears a hold.
 */
function goneSeat(stopped: Record<string, string>, seatNames: () => string[]): (seat: string) => boolean {
  let files: Set<string> | undefined
  try {
    files = new Set(seatNames())
  } catch {
    files = undefined
  }
  return seat => seat in stopped || (files !== undefined && !files.has(seat))
}

export function machineStopStatus(input: StopInputs): MachineStopStatus {
  const errors: string[] = []
  if (input.chat === undefined) errors.push('events.db cannot be read, so broadcast HOLDs are unknown')
  const file = fileHold(tryRead(input.stopFile, errors, 'stop file'))
  if (file !== undefined && 'error' in file) errors.push(file.error)
  const stopped = tryRead(input.ownerStops, errors, 'seat-watchdog.json') ?? {}
  const gone = goneSeat(stopped, input.seatNames)
  const holds = [
    ...(file === undefined || 'error' in file ? [] : [file]),
    ...broadcastHolds(input.chat ?? [], input.now.getTime(), input.operators, gone),
  ]
  const ownerStops = Object.entries(stopped).map(([seat, reason]) => ({ seat, reason }))
  const machine = { ...input.readings, stop: input.machineStop?.reason ?? null }
  const any = holds.length > 0 || machine.stop !== null || errors.length > 0
  return { at: input.now.toISOString(), stopped: any, holds, ownerStops, machine, errors }
}

/** CC-1265: `/tmp inodes 13%, /tmp bytes 20%, disk 40%`, with `?` for a reading that failed. */
const headroomReadingsText = (readings: HeadroomReadings): string =>
  HEADROOM_RESOURCES.map(resource => {
    const reading = readings[resource]
    return `${HEADROOM_SHORT_LABELS[resource]} ${'usedPercent' in reading ? reading.usedPercent : '?'}%`
  }).join(', ')

export function renderMachineStopStatus(status: MachineStopStatus): string[] {
  const { machine } = status
  return [
    `machine ${status.stopped ? 'STOPPED' : 'clear'} at ${status.at}`,
    ...status.holds.map(h => `hold (${h.kind}) by ${h.by} since ${h.since}: ${h.reason}`),
    ...status.ownerStops.map(s => `owner stop ${s.seat}: ${s.reason}`),
    `readings: memory ${machine.memoryFreePercent ?? '?'}% free, load5 ${machine.load5 ?? '?'}, ` +
      `swap ${machine.swapUsedPercent ?? '?'}% used, pressure level ${machine.pressureLevel ?? '?'}, ` +
      `CPU pressure ${machine.cpuPressurePercent ?? '?'}%, ${headroomReadingsText(machine.headroom)}`,
    ...(machine.stop === null ? [] : [`machine stop: ${machine.stop}`]),
    ...status.errors.map(e => `unreadable: ${e}`),
  ]
}
