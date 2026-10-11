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

/** The sender's name, optionally with a parenthetical, at the head of a message: "tp-ram (successor, ...): ". */
const SENDER = String.raw`(?:[\w-]+(?:\s*\([^)]*\))?(?: here)?[:,]?\s+)?`
// "tp-operator: HOLD (forecast trip)", "tp-operator MACHINE HOLD, from 07:21", "BUILD HOLD 16:19: load5 ...",
// "tp-ram-1003: LOAD HOLD from 09:53", "tp-operator: HOLD on NEW dispatch". Not "HOLD acked", "ACK HOLD",
// "HOLD dispatch of <tasks>" or "HOLD on #187": those hold one piece of work, not the machine.
const HOLD_KIND = '(?:MACHINE|BUILD|LOAD|MEMORY)'
const HOLD_SCOPE = String.raw`\s*[(:,]|\s+from\b|\s+\d|\s+on\s+(?:NEW\s+|new\s+|all\s+)?(?:dispatch|spawns)\b`
const HOLD_OPEN = new RegExp(String.raw`^${SENDER}(?:${HOLD_KIND}\s+)?HOLD(?:${HOLD_SCOPE})`)
// "tp-operator HOLD LIFTED at 16:00", "build hold LIFTED", "the HOLD is released", "tp-operator: LIFT ...", "LOAD CLEAR".
const HOLD_ENDED = /\bhold\s+(?:lifted|(?:is\s+)?released)\b/i
const LIFT = new RegExp(String.raw`^${SENDER}(?:LIFT|(?:[A-Z]+[\s-])?CLEAR)\b`)
const isLift = (body: string): boolean => HOLD_ENDED.test(body) || LIFT.test(body)

const firstLine = (text: string): string => (text.split('\n')[0] ?? '').trim().slice(0, REASON_MAX)

/** The text after the HOLD keyword, which is where every observed HOLD states its cause. */
function holdReason(body: string): string {
  const at = body.search(/HOLD/)
  return firstLine(body.slice(at + 'HOLD'.length).replace(/^\s*[:,]?\s*/, '')) || firstLine(body)
}

/**
 * Active broadcast HOLDs, one per sender: a sender's HOLD stands from its first HOLD message
 * after its own last lift. A lift relayed by another sender does not lift it; the age cap does.
 */
export function broadcastHolds(lines: readonly ChatLine[], nowMs: number): OperatorHold[] {
  const open = new Map<string, ChatLine>()
  const sorted = [...lines].filter(l => l.ts <= nowMs).sort((a, b) => a.ts - b.ts)
  for (const line of sorted) {
    const body = line.body.trimStart()
    if (isLift(body)) open.delete(line.actor)
    else if (HOLD_OPEN.test(body) && !open.has(line.actor)) open.set(line.actor, line)
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
