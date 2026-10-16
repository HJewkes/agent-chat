import { inflight, type InflightProcs } from './inflight-procs.js'
import { restartBlockers, type BlockerSource, type RestartBlockers } from './restart-guard.js'

export const SEAM_POLL_MS = 1_000

export interface SeamWait {
  source: BlockerSource
  /** `pid argv` rows of the process table; `listProcs` in production. */
  procs: () => Promise<string[]>
  deadlineMs: number
  pollMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export type SeamResult = { ok: true; waitedMs: number } | { ok: false; why: string[] }

/** Pure. One line per thing a restart would cut off; empty at the seam. */
export function seamBlockers(blockers: RestartBlockers, procs: InflightProcs): string[] {
  const lines: string[] = []
  if (blockers.spawning.length > 0) lines.push(`mid-spawn: ${blockers.spawning.join(', ')}`)
  if (procs.pushes.length > 0) lines.push(`a git push is running (pid ${procs.pushes.join(',')})`)
  if (procs.merges.length > 0) lines.push(`a merge is running (pid ${procs.merges.join(',')})`)
  return lines
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function poll(wait: SeamWait, at: number): Promise<string[]> {
  const [agents, rows] = await Promise.all([wait.source.agents(), wait.procs()])
  return seamBlockers(restartBlockers(agents, at), inflight(rows))
}

/**
 * Polls until nothing a restart would lose is in flight (the seam), or the deadline
 * passes. The deadline is checked after every poll, so a blocker that never clears
 * ends the wait instead of holding it.
 */
export async function waitForSeam(wait: SeamWait): Promise<SeamResult> {
  const now = wait.now ?? Date.now
  const sleep = wait.sleep ?? pause
  const pollMs = wait.pollMs ?? SEAM_POLL_MS
  const start = now()
  for (;;) {
    const why = await poll(wait, now())
    const waitedMs = now() - start
    if (why.length === 0) return { ok: true, waitedMs }
    if (waitedMs >= wait.deadlineMs) return { ok: false, why }
    await sleep(Math.min(pollMs, wait.deadlineMs - waitedMs))
  }
}
