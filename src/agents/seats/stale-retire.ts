import type { RetireFinishedReply } from '../burndown/daily-retire.js'

/**
 * CC-1465: the watchdog's share of the finished-agent retire. Burndown's daily retire runs only
 * inside its tick, so a pause left exited agents holding their names; this runs every pass, paused
 * or not, over the broker's stale scope, which keeps every guard of `retire_finished`.
 */

export interface StaleRetireDeps {
  retireStale: () => Promise<RetireFinishedReply>
  log?: (event: string, detail: Record<string, unknown>) => void
}

/** A line only when something was retired or the call failed; a quiet pass prints nothing. */
export async function staleRetirePass(deps: StaleRetireDeps): Promise<string[]> {
  let reply: RetireFinishedReply
  try {
    reply = await deps.retireStale()
  } catch (err) {
    return failed(deps, err instanceof Error ? err.message : String(err))
  }
  if (reply.reason !== undefined) return failed(deps, reply.reason)
  const retired = reply.results.filter(r => r.ok).length
  const failures = reply.results.length - retired
  const skipped = reply.plan.filter(e => e.action === 'skip').length
  deps.log?.('watchdog_stale_retire', { retired, skipped, failed: failures })
  if (retired === 0 && failures === 0) return []
  const failNote = failures === 0 ? '' : `, ${failures} refused`
  return [`Watchdog: retired ${retired} agent(s) exited over 24 h${failNote}`]
}

function failed(deps: StaleRetireDeps, reason: string): string[] {
  deps.log?.('watchdog_stale_retire_failed', { reason })
  return [`Watchdog: stale retire failed (${reason})`]
}
