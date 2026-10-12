import { EventLog } from '../../broker/event-log.js'
import { parseWindow } from '../../agents/burndown/dispatch-stats.js'
import { seatHookLogPath } from '../../paths.js'
import { isHookPhase, parseToolHook, recordToolCall, seatBlockReport } from '../../seat-blocks.js'
import { readStdin } from './permission-hook.js'
import fs from 'node:fs'

/** `agent-chat seat-hook <pre|post>`: records a seat's tool calls (CC-1056). Never fails the call. */
export async function seatHook(phase: string): Promise<void> {
  let log: EventLog | undefined
  try {
    if (!isHookPhase(phase)) return
    const input = parseToolHook(await readStdin())
    const seat = process.env.AGENT_CHAT_NAME
    if (input === undefined || seat === undefined || seat === '') return
    log = new EventLog()
    recordToolCall(log, seat, phase, input)
  } catch (err) {
    try {
      fs.appendFileSync(
        seatHookLogPath(),
        `${new Date().toISOString()} seat-hook ${phase} failed: ${String(err)}\n`,
      )
    } catch {
      // A log that cannot be written still must not fail the tool call.
    }
  } finally {
    try {
      log?.close()
    } catch {
      // Closing is best effort.
    }
  }
}

/** `agent-chat seat-blocks --since 24h`: each seat's blocked minutes and any block still open. */
export function seatBlocks(options: { since: string }, now: number = Date.now()): string[] {
  const windowMs = parseWindow(options.since)
  if (windowMs === undefined)
    throw new Error(`--since ${options.since} is not a window; use e.g. 90m, 24h or 7d`)
  const log = new EventLog()
  try {
    const report = seatBlockReport(log, now - windowMs, now)
    const seats = Object.entries(report.minutesBySeat).map(([seat, min]) => `${seat}: ${min} min blocked`)
    const open = report.open.map(b => `OPEN ${b.seat} (${b.sessionId}): blocked ${b.minutes} min`)
    return [...seats, ...open, ...(seats.length + open.length === 0 ? ['no seat was blocked'] : [])]
  } finally {
    log.close()
  }
}
