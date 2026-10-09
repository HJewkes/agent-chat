/**
 * CC-862: the watchdog is the seat heartbeat. A seat's own CronCreate job dies with its
 * session, so the watchdog sends the tick on the seat file's `heartbeat_cron`, stays quiet
 * through a BUDGET-PAUSE, and wakes the seat once, two minutes after the reset it logged.
 * Pure: the clock and the journal reading arrive as arguments.
 */

export const HEARTBEAT_MESSAGE = 'Heartbeat tick'

export const PAUSE_WAKE_MESSAGE = 'Heartbeat tick: BUDGET-PAUSE reset reached; resume per charter section 4'

export const PAUSE_WAKE_DELAY_MS = 2 * 60_000

/** A slot older than this is a missed tick, not a late one, e.g. across a sleep. */
export const SLOT_GRACE_MS = 20 * 60_000

/** What the watchdog remembers about a seat's heartbeat so each slot and each reset is acted on once. */
export interface HeartbeatMark {
  /** Epoch ms of the last cron slot handled. */
  slot?: number
  /** Epoch ms of the pause reset already woken for. */
  wokeFor?: number
}

export interface HeartbeatInput {
  cron: string | undefined
  nowMs: number
  /** The seat's latest log line is a `WRAP` or `PARKED` line. */
  stopped: boolean
  /** Epoch ms of the reset in the seat's latest `BUDGET-PAUSE ... until HH:MM` line. */
  pauseUntil: number | undefined
  /** The seat's latest line is a `BUDGET-PAUSE`, with or without a readable reset. */
  paused: boolean
  /** Epoch ms of the seat's latest own log line. */
  activityAt: number | undefined
  mark: HeartbeatMark | undefined
}

export interface HeartbeatStep {
  message?: string
  mark: HeartbeatMark | undefined
}

/** One cron field as the set of values it allows: `*`, `a`, `a-b`, lists, and `/n` steps. */
function fieldValues(field: string, min: number, max: number): Set<number> | undefined {
  const values = new Set<number>()
  for (const part of field.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part)
    if (m?.[1] === undefined) return undefined
    const [lo, hi] = m[1] === '*' ? [min, max] : m[1].split('-').map(Number)
    const step = m[2] === undefined ? 1 : Number(m[2])
    if (lo === undefined || step < 1 || lo < min || (hi ?? lo) > max) return undefined
    for (let v = lo; v <= (hi ?? lo); v += step) values.add(v)
  }
  return values
}

export interface CronSchedule {
  minutes: Set<number>
  hours: Set<number>
}

/** Minute and hour fields only; a cron that restricts day, month or weekday is not a heartbeat this reads. */
export function parseCron(cron: string): CronSchedule | undefined {
  const [minute, hour, ...rest] = cron.trim().split(/\s+/)
  if (minute === undefined || hour === undefined || rest.length !== 3 || rest.some(f => f !== '*'))
    return undefined
  const minutes = fieldValues(minute, 0, 59)
  const hours = fieldValues(hour, 0, 23)
  return minutes === undefined || hours === undefined ? undefined : { minutes, hours }
}

/** The latest slot at or before `nowMs` and within `SLOT_GRACE_MS` of it. */
export function latestSlot(cron: string, nowMs: number): number | undefined {
  const schedule = parseCron(cron)
  if (schedule === undefined) return undefined
  const minuteMs = 60_000
  for (let t = Math.floor(nowMs / minuteMs) * minuteMs; nowMs - t <= SLOT_GRACE_MS; t -= minuteMs) {
    const d = new Date(t)
    if (schedule.minutes.has(d.getMinutes()) && schedule.hours.has(d.getHours())) return t
  }
  return undefined
}

function pauseStep(input: HeartbeatInput): HeartbeatStep {
  const { pauseUntil, nowMs, mark } = input
  if (pauseUntil === undefined || nowMs < pauseUntil + PAUSE_WAKE_DELAY_MS || mark?.wokeFor === pauseUntil)
    return { mark }
  return { message: PAUSE_WAKE_MESSAGE, mark: { ...mark, wokeFor: pauseUntil } }
}

export function heartbeatStep(input: HeartbeatInput): HeartbeatStep {
  const { cron, nowMs, mark, activityAt } = input
  if (cron === undefined || input.stopped) return { mark }
  if (input.paused) return pauseStep(input)
  const slot = latestSlot(cron, nowMs)
  if (slot === undefined || (mark?.slot !== undefined && mark.slot >= slot)) return { mark }
  const next = { ...mark, slot }
  // The first sight of a seat only marks the slot: nothing says whether that tick was already sent.
  if (mark?.slot === undefined) return { mark: next }
  // A seat that logged since the slot ran its own heartbeat, so a second tick would double it.
  if (activityAt !== undefined && activityAt >= slot) return { mark: next }
  return { message: HEARTBEAT_MESSAGE, mark: next }
}
