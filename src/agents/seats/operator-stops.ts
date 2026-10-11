import type { MachineStop, MachineStopReadings } from './stops.js'

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
}

export interface OperatorHold {
  kind: 'broadcast' | 'file'
  by: string
  /** ISO time the hold began. */
  since: string
  reason: string
  /** The message that opened a broadcast hold. */
  msgId?: string
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
export function messageHead(body: string): string {
  const first = body.trimStart().split('\n')[0] ?? ''
  const end = first.search(/[.!?;](?:\s|$)/)
  return (end === -1 ? first : first.slice(0, end)).slice(0, HEAD_MAX)
}

/**
 * Fail closed (CC-957 review): every stop word in a head opens a hold unless the words right beside
 * that one occurrence say it refers to a hold or names one target. A phrasing nobody foresaw opens;
 * it never lifts, since only a head that starts with a lift form lifts.
 */
const STOP_WORD =
  /\bHOLD\b|\bMACHINE STOP\b|\b(?:STOP|[Ss]top)[ -](?:ALL|all)\b|\bSTOP\b|\bSTEP-BACK\b|\bREBOOT (?:NOTICE|QUIET)\b/
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
  if (liftsTheHold(head)) return 'lift'
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

/**
 * Active broadcast HOLDs, one per sender, each dated from that sender's first stop since the last
 * lift. A lift from any sender ends every open hold: the hold is the machine's, and coordinators relay
 * an operator's HOLD as their own but never lift it, so per-sender lifts left relays standing a day.
 */
export function broadcastHolds(lines: readonly ChatLine[], nowMs: number): OperatorHold[] {
  const open = new Map<string, ChatLine>()
  const sorted = [...lines].filter(l => l.ts <= nowMs).sort((a, b) => a.ts - b.ts)
  for (const line of sorted) {
    const kind = classify(line.body, line.actor)
    if (kind === 'lift') open.clear()
    else if (kind === 'open' && !open.has(line.actor)) open.set(line.actor, line)
  }
  return [...open.values()]
    .filter(line => nowMs - line.ts <= BROADCAST_HOLD_MAX_MS)
    .map(line => ({
      kind: 'broadcast' as const,
      by: line.actor,
      since: new Date(line.ts).toISOString(),
      reason: holdReason(line.body.trimStart()),
      ...(line.msgId === null ? {} : { msgId: line.msgId }),
    }))
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
  /** The stop file's text; undefined when it does not exist. */
  stopFile: () => string | undefined
  /** seat-watchdog.json's `stopped` map; throws when the file cannot be read. */
  ownerStops: () => Record<string, string>
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

export function machineStopStatus(input: StopInputs): MachineStopStatus {
  const errors: string[] = []
  if (input.chat === undefined) errors.push('events.db cannot be read, so broadcast HOLDs are unknown')
  const file = fileHold(tryRead(input.stopFile, errors, 'stop file'))
  if (file !== undefined && 'error' in file) errors.push(file.error)
  const holds = [
    ...(file === undefined || 'error' in file ? [] : [file]),
    ...broadcastHolds(input.chat ?? [], input.now.getTime()),
  ]
  const stopped = tryRead(input.ownerStops, errors, 'seat-watchdog.json') ?? {}
  const ownerStops = Object.entries(stopped).map(([seat, reason]) => ({ seat, reason }))
  const machine = { ...input.readings, stop: input.machineStop?.reason ?? null }
  const any = holds.length > 0 || machine.stop !== null || errors.length > 0
  return { at: input.now.toISOString(), stopped: any, holds, ownerStops, machine, errors }
}

export function renderMachineStopStatus(status: MachineStopStatus): string[] {
  const { machine } = status
  return [
    `machine ${status.stopped ? 'STOPPED' : 'clear'} at ${status.at}`,
    ...status.holds.map(h => `hold (${h.kind}) by ${h.by} since ${h.since}: ${h.reason}`),
    ...status.ownerStops.map(s => `owner stop ${s.seat}: ${s.reason}`),
    `readings: memory ${machine.memoryFreePercent ?? '?'}% free, load5 ${machine.load5 ?? '?'}, ` +
      `swap ${machine.swapUsedPercent ?? '?'}% used, pressure level ${machine.pressureLevel ?? '?'}`,
    ...(machine.stop === null ? [] : [`machine stop: ${machine.stop}`]),
    ...status.errors.map(e => `unreadable: ${e}`),
  ]
}
