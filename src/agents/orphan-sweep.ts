import type { AgentIdentity } from '../protocol.js'
import {
  findTargets,
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
  /** False logs `orphans_would_reap` and signals nothing. */
  kill: () => boolean
  /** Pids already logged as would-reap, so a standing stray is announced once rather than every minute. */
  announced: Set<number>
}

/** One sweep. Returns the report when anything was reaped. */
export async function sweepOrphans(deps: SweepDeps): Promise<ReapReport | undefined> {
  const finished = finishedIds(deps.roster(), deps.now())
  if (finished.size === 0) return undefined
  const table = deps.table()
  const match = matchFinished(finished, table)
  if (!deps.kill()) {
    const wouldReap = findTargets(table, match).filter(t => !deps.announced.has(t.pid))
    if (wouldReap.length === 0) return undefined
    for (const t of wouldReap) deps.announced.add(t.pid)
    const report = reportOf(wouldReap, [])
    deps.log('orphans_would_reap', { source: 'sweep', ...report })
    return report
  }
  const targets = startReap(table, match)
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
  kill: SweepDeps['kill'],
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
    kill,
    announced: new Set(),
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
