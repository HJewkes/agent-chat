import path from 'node:path'
import type { JobSpec } from '../../mirror/plist.js'
import { renderUnits, type RenderedUnits } from '../../mirror/systemd-unit.js'
import { parseCron } from './heartbeat.js'

/**
 * CC-947: a seat's CronCreate heartbeat dies with its session, so a systemd user timer per seat
 * fires on the seat's `heartbeat_cron` minutes and, when the seat logged no tick line for its
 * cron's widest gap plus five minutes, sends the charter heartbeat message itself. Pure: the clock and the logs arrive as arguments.
 */

/** What the seat's own CronCreate job runs, so a fallback tick reads exactly like one. */
export const EXTERNAL_HEARTBEAT_MESSAGE = 'Heartbeat tick per charter section 3'

/** A slow tick logs this long after its slot; past one missed slot plus this, the seat's cron is gone. */
export const EXTERNAL_SLACK_MS = 5 * 60_000

export const HEARTBEAT_UNIT_PREFIX = 'agent-chat-heartbeat-'

/**
 * Section 3.5 of the charter asks for one line per tick but names no keyword, so seats write
 * `tick:`, `tick.`, `tick (`, `TICK` and `Boot tick:`. Any case, any punctuation, after at most
 * one leading word. Seats sometimes write the last minute digit as `x`; that reads as 0, the
 * earliest it could be, so a doubtful tick never suppresses a heartbeat.
 */
const TICK_LINE = /^(\d\d):(\d)([\dx]) (?:[a-z]+ )?tick\b/i

/** Epoch ms of the latest tick line in the seat's log for local day `day`; undefined when it has none. */
export function lastTickAt(log: string, day: Date): number | undefined {
  let latest: number | undefined
  for (const line of log.split('\n')) {
    const m = TICK_LINE.exec(line)
    if (m === null) continue
    const minute = Number(m[2]) * 10 + (m[3]?.toLowerCase() === 'x' ? 0 : Number(m[3]))
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(m[1]), minute).getTime()
    if (latest === undefined || at > latest) latest = at
  }
  return latest
}

export interface ExternalInput {
  nowMs: number
  lastTickAt: number | undefined
  /** From `quietLimitMs` over the seat's cron. */
  quietMs: number
  /** Why the seat's latest line stops it (`WRAP`, `PARKED`, `BUDGET-PAUSE`); a fallback tick must not end that. */
  stop: string | undefined
}

export interface ExternalVerdict {
  send: boolean
  reason: string
}

const minutes = (ms: number): number => Math.floor(ms / 60_000)

export function judgeExternal(input: ExternalInput): ExternalVerdict {
  const { nowMs, lastTickAt: tick, stop, quietMs } = input
  if (stop !== undefined) return { send: false, reason: `held: ${stop}` }
  if (tick !== undefined && nowMs - tick < quietMs)
    return { send: false, reason: `ticked ${minutes(nowMs - tick)} min ago, under ${minutes(quietMs)}` }
  const quiet =
    tick === undefined ? 'no tick line today or yesterday' : `no tick for ${minutes(nowMs - tick)} min`
  return { send: true, reason: quiet }
}

/** Where a seat's units point: the CLI to run and the environment and log dir it runs with. */
export interface HeartbeatJobContext {
  nodePath: string
  cliEntry: string
  root: string
  env: Record<string, string>
  logDir: string
}

export const heartbeatUnitName = (seat: string): string => `${HEARTBEAT_UNIT_PREFIX}${seat}`

/** The timer's minutes, or why the cron cannot drive one: an hour-restricted cron needs a calendar this does not render. */
export function heartbeatMinutes(cron: string | undefined): number[] | string {
  if (cron === undefined) return 'no heartbeat_cron'
  const schedule = parseCron(cron)
  if (schedule === undefined) return `heartbeat_cron "${cron}" is not a minute-and-hour cron`
  if (schedule.hours.size !== 24)
    return `heartbeat_cron "${cron}" restricts hours, which the timer does not render`
  return [...schedule.minutes].sort((a, b) => a - b)
}

/** The widest gap between the cron's slots, across the hour, plus the slack: `17,47` gives 35 min, `17` gives 65. */
export function quietLimitMs(minutesPastHour: readonly number[]): number {
  const sorted = [...minutesPastHour].sort((a, b) => a - b)
  const gaps = sorted.map((m, i) => ((sorted[(i + 1) % sorted.length] ?? m) - m + 60) % 60 || 60)
  return Math.max(...gaps) * 60_000 + EXTERNAL_SLACK_MS
}

/** The seat's service and timer, or why it gets none. */
export function heartbeatUnits(
  seat: string,
  cron: string | undefined,
  ctx: HeartbeatJobContext,
): RenderedUnits | string {
  const mins = heartbeatMinutes(cron)
  if (typeof mins === 'string') return mins
  const spec: JobSpec = {
    label: `agent-chat heartbeat fallback for ${seat}`,
    args: [ctx.nodePath, ctx.cliEntry, 'seats', 'heartbeat-check', '--seat', seat, '--root', ctx.root],
    logFile: path.join(ctx.logDir, `${seat}.log`),
    runAtLoad: false,
    schedule: { kind: 'minutes', minutes: mins },
    env: ctx.env,
  }
  return renderUnits(spec, heartbeatUnitName(seat))
}
