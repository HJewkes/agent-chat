import type { AgentIdentity } from '../protocol.js'
import {
  finishedIds,
  finishReap,
  KILL_GRACE_MS,
  matchFinished,
  procTable,
  reportOf,
  startReap,
  type ProcessTable,
  type ReapReport,
} from './orphan-reap.js'

export const ORPHAN_SWEEP_MS = 60_000

export interface SweepDeps {
  roster: () => readonly AgentIdentity[]
  table: () => ProcessTable
  log: (event: string, detail: Record<string, unknown>) => void
  sleep: (ms: number) => Promise<void>
  now: () => number
}

/** One sweep. Returns the report when anything was reaped. */
export async function sweepOrphans(deps: SweepDeps): Promise<ReapReport | undefined> {
  const finished = finishedIds(deps.roster(), deps.now())
  if (finished.size === 0) return undefined
  const table = deps.table()
  const targets = startReap(table, matchFinished(finished, table))
  if (targets.length === 0) return undefined
  await deps.sleep(KILL_GRACE_MS)
  const survivors = finishReap(table, targets)
  const report = reportOf(targets, survivors)
  deps.log('orphans_reaped', { source: 'sweep', ...report })
  return report
}

/** Sweeps on an unref'd interval, never overlapping. Returns its cancel. */
export function startOrphanSweep(
  roster: SweepDeps['roster'],
  log: SweepDeps['log'],
  intervalMs = ORPHAN_SWEEP_MS,
): () => void {
  if (process.platform !== 'linux') {
    log('orphan_sweep_disabled', { reason: `no /proc on ${process.platform}; orphan reaping is a no-op` })
    return () => undefined
  }
  const deps: SweepDeps = {
    roster,
    table: procTable,
    log,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: Date.now,
  }
  let running = false
  const timer = setInterval(() => {
    if (running) return
    running = true
    // A failed sweep must never take the broker down.
    void sweepOrphans(deps)
      .catch(() => undefined)
      .finally(() => {
        running = false
      })
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
