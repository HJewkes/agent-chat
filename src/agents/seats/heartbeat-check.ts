import { parseSeat } from './charter.js'
import {
  EXTERNAL_HEARTBEAT_MESSAGE,
  heartbeatMinutes,
  judgeExternal,
  lastTickAt,
  quietLimitMs,
} from './heartbeat-external.js'
import { seatGate, type WakeResult, type WatchdogDeps } from './run.js'

/**
 * CC-947: what one firing of a seat's heartbeat timer does. Whether the seat is connected and
 * held is the watchdog's own judgement (`seatGate`); only the tick reading is this module's.
 */

export interface HeartbeatCheckDeps {
  /** The watchdog's readings: seat file, every log day, roster, owner stops, restart window, machine pressure. */
  watchdog: WatchdogDeps
  send: (seat: string, message: string) => Promise<WakeResult>
  logEvent: (event: string, detail: Record<string, unknown>) => void
}

export interface CheckResult {
  ok: boolean
  line: string
}

/** The newest tick in any log day, newest day first, so a tick in an old file still counts. */
function latestTick(deps: WatchdogDeps, seat: string): number | undefined {
  for (const day of deps.seatLogDays(seat)) {
    const at = lastTickAt(deps.readSeatLog(seat, day) ?? '', day)
    if (at !== undefined) return at
  }
  return undefined
}

/** Why the fallback stays quiet before it reads ticks, or the quiet limit when it may send. */
async function gate(deps: WatchdogDeps, name: string): Promise<string | number> {
  const seat = parseSeat(name, deps.readSeatFile(name) ?? '')
  if (seat === undefined) return `seats/${name}.md has no prefix or pool`
  const mins = heartbeatMinutes(seat.heartbeatCron)
  if (typeof mins === 'string') return mins
  const { connected, hold } = await seatGate(deps, seat)
  if (hold !== undefined) return `held: ${hold}`
  // A dark seat is the watchdog's to resume; a send would sit in the broker's hold for it.
  if (!connected) return 'not connected'
  return quietLimitMs(mins)
}

export async function checkHeartbeat(
  deps: HeartbeatCheckDeps,
  seat: string,
  dryRun: boolean,
): Promise<CheckResult> {
  const limit = await gate(deps.watchdog, seat)
  if (typeof limit === 'string') return { ok: true, line: `${seat}: skip: ${limit}` }
  const nowMs = deps.watchdog.now().getTime()
  const verdict = judgeExternal({ nowMs, lastTickAt: latestTick(deps.watchdog, seat), quietMs: limit })
  if (!verdict.send) return { ok: true, line: `${seat}: skip: ${verdict.reason}` }
  if (dryRun) return { ok: true, line: `${seat}: WOULD SEND: ${verdict.reason}` }
  const sent = await deps.send(seat, EXTERNAL_HEARTBEAT_MESSAGE)
  deps.logEvent('heartbeat_external', { seat, reason: verdict.reason, ok: sent.ok, detail: sent.detail })
  const outcome = sent.ok ? `sent (${sent.detail})` : `send FAILED (${sent.detail})`
  return { ok: sent.ok, line: `${seat}: ${verdict.reason}; heartbeat ${outcome}` }
}
