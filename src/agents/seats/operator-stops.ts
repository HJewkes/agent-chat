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
 * Open by default (CC-957 review): a head carrying a stop word opens a hold, so a phrasing nobody
 * foresaw ("HOLD now", "SPAWN HOLD at 15:28", "STOP ALL DISPATCH") is reported rather than dropped.
 * Only the narrow exceptions below skip it.
 */
const STOP_WORD = /\bHOLD\b|\bSTOP[ -]ALL\b|\bMACHINE STOP\b|\bSTEP-BACK\b|\bREBOOT (?:NOTICE|QUIET)\b/
/** The sender as messages open: "tp-operator: ", "tp-ram (successor of tp-ram-1003): ", "tp-operator 22:4x: ". */
const SENDER = String.raw`^(?:[\w-]+(?:\s*\([^)]*\))?(?:\s+\d\d:\d[\dx])?[:,]?\s+)?`
/**
 * A lift is said in one of two shapes, and only these lift: the head opens with LIFT or a CLEAR
 * ("tp-operator: LIFT at NORMAL pace", "LOAD CLEAR 22:34", "ALL-CLEAR on ee8b92f3"), or it says a hold or
 * stop is lifted or released ("STOP ALL and the build hold are LIFTED", "REBOOT QUIET RELEASED 13:39").
 * "no LIFT time known", "holding for LIFT" and "holding spawns until CLEAR" say a hold still stands.
 */
const LIFT_LEAD = new RegExp(String.raw`${SENDER}(?:LIFT\b|(?:[A-Z]+[ -])?CLEAR\b)`)
const HOLD_ENDED = /(?<!restart\s)\b(?:hold|stop|quiet)s?\s+(?:is\s+|are\s+)?(?:lifted|released)\b/i
const ACKNOWLEDGEMENT = /\back(?:ed|nowledged)?\b|\bre\s+[0-9a-f]{8}\b|^re\b/i
/** A head citing another message ("under HOLD 058d18db", "tp-ram-1003 1f34db91") refers to a hold; it does not open one. */
const CITES_MESSAGE = /\b[0-9a-f]{8}\b/
/** "no memory HOLD now", "not a HOLD yet", "under your 08:59 HOLD", "My HOLD covers", "at the MACHINE STOP gate". */
const REFERS_BACK =
  /\b(?:no|not\s+a|under|my|your|the|still\s+in|during\s+a)\b[^,;.]{0,30}\b(?:HOLD|MACHINE STOP)\b|\bHOLD\s+(?:stays|still|covers|applies)\b/i
/** A hold on one piece of work: "HOLD on #187", "HOLD dispatch of CC-763", "HOLD the PR", "#722 hold RELEASED". */
const TASK_HOLD =
  /\bHOLD\s+(?:on\s+#|dispatch\s+of\b|the\b|both\b|PR\b|#)|(?:#\d+|\b[A-Z]{2,5}-\d+)\s+holds?\b/i

export type Classified = 'open' | 'lift' | 'none'

export function classify(body: string): Classified {
  const head = messageHead(body)
  // A lift is read first, since most lifts name the hold they end ("HOLD LIFTED", "LIFT of HOLD 612eaf59").
  if (!TASK_HOLD.test(head) && (LIFT_LEAD.test(head) || HOLD_ENDED.test(head))) return 'lift'
  const exception = [ACKNOWLEDGEMENT, TASK_HOLD, CITES_MESSAGE, REFERS_BACK].some(rule => rule.test(head))
  if (!STOP_WORD.test(head) || exception) return 'none'
  return 'open'
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
    const kind = classify(line.body)
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
