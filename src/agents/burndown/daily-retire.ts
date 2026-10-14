import type { RetirePlanEntry, RetireResult } from '../../protocol.js'
import { dayStart } from './budget-gate.js'

/**
 * TP-1974 c: the charter's mechanical cleanup, once a day after 07:00 local. Each enrolled seat's finished
 * agents are retired over the broker's `retire_finished` frame, scoped to the seat as spawner; the broker
 * already skips agents holding unpushed or uncommitted work, and implementers (Shepherd-registered ones
 * included) and reviewers whose PR is open (CC-1325).
 */

/** The `retire_finished_result` frame's body. */
export interface RetireFinishedReply {
  ok: boolean
  reason?: string
  plan: RetirePlanEntry[]
  results: RetireResult[]
}

export interface DailyRetireDeps {
  retireFinished: (spawner: string) => Promise<RetireFinishedReply>
  seatLog: (seat: string, text: string) => void
  log: (event: string, detail: Record<string, unknown>) => void
  now: Date
}

export interface DailyRetired {
  lines: string[]
  /** The seats that ran, stamped with the tick's time; a seat whose call failed is absent, so the next tick retries it. */
  stamps: Record<string, string>
}

/** The seats not yet retired since today's 07:00 local; none before 07:00. */
export function dailyRetireDue(
  seats: readonly string[],
  lastRun: Readonly<Record<string, string>> | undefined,
  now: Date,
): string[] {
  const start = dayStart(now)
  if (new Date(start).toDateString() !== now.toDateString()) return []
  return seats.filter(seat => {
    const last = lastRun?.[seat]
    return last === undefined || Date.parse(last) < start
  })
}

/** A failed call is an event and leaves the seat due; it never fails the tick. */
export async function dailyRetire(
  seats: readonly string[],
  lastRun: Readonly<Record<string, string>> | undefined,
  deps: DailyRetireDeps,
): Promise<DailyRetired> {
  const lines: string[] = []
  const stamps: Record<string, string> = {}
  for (const seat of dailyRetireDue(seats, lastRun, deps.now)) {
    const line = await retireSeat(seat, deps)
    if (line === undefined) continue
    lines.push(line)
    stamps[seat] = deps.now.toISOString()
  }
  return { lines, stamps }
}

async function retireSeat(seat: string, deps: DailyRetireDeps): Promise<string | undefined> {
  let reply: RetireFinishedReply
  try {
    reply = await deps.retireFinished(seat)
  } catch (err) {
    deps.log('burndown_daily_retire_failed', {
      seat,
      reason: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
  if (reply.reason !== undefined) {
    deps.log('burndown_daily_retire_failed', { seat, reason: reply.reason })
    return undefined
  }
  const retired = reply.results.filter(r => r.ok).length
  const failed = reply.results.length - retired
  const skipped = reply.plan.filter(e => e.action === 'skip').length
  const text = `burndown: retired ${retired} finished (${seat})`
  deps.log('burndown_daily_retire', { seat, retired, skipped, failed })
  // A daily "retired 0" line would only crowd the seat log; the event above still records the run.
  if (retired === 0) return text
  try {
    deps.seatLog(seat, text)
  } catch (err) {
    deps.log('burndown_seat_log_failed', { seat, reason: err instanceof Error ? err.message : String(err) })
  }
  return text
}
