import type { Claim, Ledger, ReleaseRecord } from './ledger.js'

/**
 * The ledger write behind `burndown release` (CC-700, CC-978), shared with the tick's own release of a
 * claim whose agent is gone (CC-1054): one place decides what a release drops and what it counts.
 */

export interface Released {
  ledger: Ledger
  dropped: Claim[]
  /** The task's backoff record; absent for a slice release, which counts none. */
  hold?: ReleaseRecord
}

/**
 * Drops every held claim on `task`, or only `slice`'s claim. A whole-task release counts toward its
 * backoff and lets the task be seeded again; a release with no held claim leaves the ledger as it was.
 */
export function releaseHeld(ledger: Ledger, task: string, now: Date, slice?: string): Released {
  const dropped = ledger.claims.filter(
    c => c.taskId === task && c.phase !== 'done' && (slice === undefined || c.slice === slice),
  )
  if (dropped.length === 0) return { ledger, dropped }
  const claims = ledger.claims.filter(c => !dropped.includes(c))
  if (slice !== undefined) return { ledger: releaseSlice(ledger, claims, task, slice), dropped }
  const hold = { n: (ledger.releases?.[task]?.n ?? 0) + 1, at: now.toISOString() }
  const next = {
    ...withoutSliceReleases(ledger, task),
    claims,
    releases: { ...ledger.releases, [task]: hold },
  }
  return { ledger: next, dropped, hold }
}

/**
 * One slice's release: the task's other slices keep their claims, the task stays seeded, and the dropped
 * slice no longer gates its dependents. No backoff is counted, since that would hold the other slices back.
 */
function releaseSlice(ledger: Ledger, claims: Claim[], task: string, slice: string): Ledger {
  const released = [...new Set([...(ledger.slicesReleased?.[task] ?? []), slice])]
  return { ...ledger, claims, slicesReleased: { ...ledger.slicesReleased, [task]: released } }
}

/** A whole-task release lets the task be seeded again. */
function withoutSliceReleases(ledger: Ledger, task: string): Ledger {
  const { slicesReleased: all, ...rest } = ledger
  const { [task]: _cleared, ...kept } = all ?? {}
  return Object.keys(kept).length === 0 ? rest : { ...rest, slicesReleased: kept }
}
