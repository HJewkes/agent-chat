import { EXTERNAL_HEARTBEAT_MESSAGE, judgeExternal, lastTickAt } from './heartbeat-external.js'
import type { WakeResult } from './run.js'
import { readSeatLog } from './stops.js'

/** CC-947: what one firing of a seat's heartbeat timer does. Every reading and the send are injected. */

export interface HeartbeatCheckDeps {
  now: () => Date
  /** The seat's log for the local day of `at`; undefined when there is none. */
  readSeatLog: (seat: string, at: Date) => string | undefined
  send: (seat: string, message: string) => Promise<WakeResult>
  logEvent: (event: string, detail: Record<string, unknown>) => void
}

export interface CheckResult {
  ok: boolean
  line: string
}

interface DayLog {
  day: Date
  text: string
}

/** Today and yesterday, so a tick just before midnight still counts after it. */
function recentLogs(deps: HeartbeatCheckDeps, seat: string, now: Date): DayLog[] {
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12)
  return [now, yesterday].map(day => ({ day, text: deps.readSeatLog(seat, day) ?? '' }))
}

const latestTick = (logs: DayLog[]): number | undefined =>
  logs.reduce<number | undefined>((best, { day, text }) => {
    const at = lastTickAt(text, day)
    return at === undefined || (best !== undefined && best >= at) ? best : at
  }, undefined)

/** The newest day with a seat line decides the stop, as the watchdog reads it. */
const stopOf = (logs: DayLog[]): string | undefined =>
  logs.map(({ day, text }) => readSeatLog(text, day)).find(v => v.activityAt !== undefined)?.stop

export async function checkHeartbeat(
  deps: HeartbeatCheckDeps,
  seat: string,
  dryRun: boolean,
): Promise<CheckResult> {
  const now = deps.now()
  const logs = recentLogs(deps, seat, now)
  const verdict = judgeExternal({ nowMs: now.getTime(), lastTickAt: latestTick(logs), stop: stopOf(logs) })
  if (!verdict.send) return { ok: true, line: `${seat}: skip: ${verdict.reason}` }
  if (dryRun) return { ok: true, line: `${seat}: WOULD SEND: ${verdict.reason}` }
  const sent = await deps.send(seat, EXTERNAL_HEARTBEAT_MESSAGE)
  deps.logEvent('heartbeat_external', { seat, reason: verdict.reason, ok: sent.ok, detail: sent.detail })
  const outcome = sent.ok ? `sent (${sent.detail})` : `send FAILED (${sent.detail})`
  return { ok: sent.ok, line: `${seat}: ${verdict.reason}; heartbeat ${outcome}` }
}
