import { EventLog } from '../../broker/event-log.js'
import { parseWindow } from '../../agents/burndown/dispatch-stats.js'
import { currentAutonomyRoot } from '../../agents/autonomy-root.js'
import { restartRunOnOwnerPrompt, submittedPrompt } from '../../agents/seats/owner-prompt.js'
import { isSeatOrSeatWorker } from '../../agents/seats/seat-of.js'
import { denyOutput } from '../../leak-guard/pretool.js'
import { seatHookLogPath } from '../../paths.js'
import {
  isHookPhase,
  PANE_QUESTION_DENIAL,
  paneQuestionVerdict,
  parseToolHook,
  recordToolCall,
  seatBlockReport,
} from '../../seat-blocks.js'
import { readStdin } from './permission-hook.js'
import { runStartDeps } from './seats.js'
import fs from 'node:fs'

function logFailure(phase: string, what: string, err: unknown): void {
  try {
    fs.appendFileSync(
      seatHookLogPath(),
      `${new Date().toISOString()} seat-hook ${phase} ${what}: ${String(err)}\n`,
    )
  } catch {
    // A log that cannot be written still must not fail the tool call.
  }
}

/** A seat lookup that cannot read the seat files allows the call: a broken root must not stop every session asking. */
function isSeatFailingOpen(name: string): boolean {
  try {
    return isSeatOrSeatWorker(currentAutonomyRoot(), name)
  } catch (err) {
    logFailure('pre', 'seat lookup failed, allowing', err)
    return false
  }
}

/** CC-281 b: an owner's prompt to a seat starts its new run; a refusal is logged, never waited out. */
async function ownerPromptRun(seat: string, raw: string): Promise<void> {
  const prompt = submittedPrompt(raw)
  if (prompt === undefined) return
  await restartRunOnOwnerPrompt(runStartDeps(currentAutonomyRoot()), seat, prompt, err =>
    logFailure('end', 'run-start refused', err),
  )
}

/**
 * `agent-chat seat-hook <pre|post|end>`: records a seat's tool calls (CC-1056), denies a seat's
 * pane question (CC-1092) and restarts its run meter on an owner prompt. Never fails the call.
 */
export async function seatHook(phase: string): Promise<void> {
  let log: EventLog | undefined
  try {
    if (!isHookPhase(phase)) return
    const raw = await readStdin()
    const input = parseToolHook(raw)
    const seat = process.env.AGENT_CHAT_NAME
    if (input === undefined || seat === undefined || seat === '') return
    const denied = phase === 'pre' && paneQuestionVerdict(seat, input.toolName, isSeatFailingOpen) === 'deny'
    if (denied) process.stdout.write(`${denyOutput(PANE_QUESTION_DENIAL)}\n`)
    log = new EventLog()
    recordToolCall(log, seat, phase, input, denied)
    if (phase === 'end') await ownerPromptRun(seat, raw)
  } catch (err) {
    logFailure(phase, 'failed', err)
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
