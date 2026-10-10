import path from 'node:path'
import type { JobSpec } from '../../mirror/plist.js'
import { renderUnits, type RenderedUnits } from '../../mirror/systemd-unit.js'
import { parseCron } from './heartbeat.js'

/**
 * CC-947: a seat's CronCreate heartbeat dies with its session, so a systemd user timer per seat
 * fires on the seat's `heartbeat_cron` minutes and, when the seat logged no tick line for 35
 * minutes, sends the charter heartbeat message itself. Pure: the clock and the logs arrive as arguments.
 */

/** What the seat's own CronCreate job runs, so a fallback tick reads exactly like one. */
export const EXTERNAL_HEARTBEAT_MESSAGE = 'Heartbeat tick per charter section 3'

/** One missed 30-minute slot plus five minutes for a slow tick: quieter than this, the seat's cron is gone. */
export const EXTERNAL_QUIET_MS = 35 * 60_000

export const HEARTBEAT_UNIT_PREFIX = 'agent-chat-heartbeat-'

/**
 * Charter section 3.5's tick line, `HH:MM tick: ...`. Seats sometimes write the last minute digit
 * as `x`; that reads as 0, the earliest it could be, so a doubtful tick never suppresses a heartbeat.
 */
const TICK_LINE = /^(\d\d):(\d)([\dx]) tick\b/

/** Epoch ms of the latest tick line in the seat's log for local day `day`; undefined when it has none. */
export function lastTickAt(log: string, day: Date): number | undefined {
  let latest: number | undefined
  for (const line of log.split('\n')) {
    const m = TICK_LINE.exec(line)
    if (m === null) continue
    const minute = Number(m[2]) * 10 + (m[3] === 'x' ? 0 : Number(m[3]))
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(m[1]), minute).getTime()
    if (latest === undefined || at > latest) latest = at
  }
  return latest
}

export interface ExternalInput {
  nowMs: number
  lastTickAt: number | undefined
  /** Why the seat's latest line stops it (`WRAP`, `PARKED`, `BUDGET-PAUSE`); a fallback tick must not end that. */
  stop: string | undefined
}

export interface ExternalVerdict {
  send: boolean
  reason: string
}

const minutes = (ms: number): number => Math.floor(ms / 60_000)

export function judgeExternal(input: ExternalInput): ExternalVerdict {
  const { nowMs, lastTickAt: tick, stop } = input
  if (stop !== undefined) return { send: false, reason: `held: ${stop}` }
  if (tick !== undefined && nowMs - tick < EXTERNAL_QUIET_MS)
    return { send: false, reason: `ticked ${minutes(nowMs - tick)} min ago, under 35` }
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
