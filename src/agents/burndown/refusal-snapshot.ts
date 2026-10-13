import fs from 'node:fs'
import path from 'node:path'
import { home } from '../../paths.js'
import type { RefusalKind } from './eligibility.js'
import type { SeatOutcome } from './no-dispatch.js'

/**
 * CC-1241: every seat's refusals from the last tick, with the task or PR each waits on, so a reader can see
 * what blocks dispatch without parsing reason text. The tick overwrites the file whole; it is never appended.
 */

/** An open task a `dep-blocked` row waits on, or the open PR a `file-overlap` row collides with. */
export type Blocker = { task: string; state: string } | { pr: number; repo: string }

export interface RefusalRow {
  seat: string
  initiative: string
  task?: string
  slice?: string
  kind: RefusalKind
  reason: string
  blocker?: Blocker
}

export interface RefusalSnapshot {
  /** ISO time of the tick that wrote it. */
  ts: string
  refusals: RefusalRow[]
}

export const burndownRefusalsPath = (): string => path.join(home(), 'burndown-refusals.json')

export function refusalSnapshot(outcomes: readonly SeatOutcome[], now: Date): RefusalSnapshot {
  const refusals = outcomes.flatMap(({ seat, refusals: refused }) =>
    refused.map(r => ({
      seat,
      initiative: r.initiative,
      ...(r.task !== undefined && { task: r.task }),
      ...(r.slice !== undefined && { slice: r.slice }),
      kind: r.kind,
      reason: r.reason,
      ...(r.blocker !== undefined && { blocker: r.blocker }),
    })),
  )
  return { ts: now.toISOString(), refusals }
}

export function writeRefusalSnapshot(file: string, snapshot: RefusalSnapshot): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tmp, file)
}
