import { burndownLedgerPath } from '../../paths.js'
import { heldUntil } from '../../agents/burndown/backoff.js'
import { shepherdTarget } from '../../agents/burndown/shepherd.js'
import {
  readLedger,
  withLedgerLock,
  writeLedger,
  type Claim,
  type Ledger,
} from '../../agents/burndown/ledger.js'
import { pendingOffLedger, type PlanReader } from '../../agents/burndown/seed-slices.js'
import { slicesReleasedUnclaimed } from '../../agents/burndown/slices-complete.js'
import type { Report } from '../command.js'

export type RetireCall = (name: string) => Promise<{ ok: boolean; reason?: string }>

const refusedReport = (message: string): Report => ({ ok: false, lines: [], errors: [message] })

/** Newest first, the order `retireAll` in advance.ts uses; `spawned` is kept oldest first. */
const newestFirst = (claim: Claim): string[] => [...new Set([...(claim.spawned ?? [])].reverse())]

const describeClaim = (c: Claim): string =>
  `released ${c.taskId}${c.slice === undefined ? '' : ` slice ${c.slice}`} (${c.phase}${c.stalledReason === undefined ? '' : `, stalled: ${c.stalledReason}`})`

async function retireNames(claim: Claim, retire: RetireCall): Promise<string[]> {
  const lines: string[] = []
  for (const name of newestFirst(claim)) {
    const reply = await retire(name).catch((err: Error) => ({ ok: false, reason: err.message }))
    lines.push(reply.ok ? `retired ${name}` : `left ${name}: ${reply.reason ?? 'refused'}`)
  }
  return lines
}

/**
 * Drops every held claim on `task`, counts the release toward its backoff (CC-700), then retires each
 * one's spawned agents; a refused retire never keeps a claim. A release with no held claim changes nothing,
 * except that a task with released slices and no slice claim (`slicesReleasedUnclaimed`) is cleared to reseed.
 * With `slice`, only that slice's claim is dropped (CC-978); see `releaseSlice`. `readPlan` lets it release an
 * unclaimed slice an off-ledger run holds (CC-1240).
 */
export async function releaseTask(
  task: string,
  retire: RetireCall,
  now = new Date(),
  slice?: string,
  readPlan?: PlanReader,
): Promise<Report> {
  const file = burndownLedgerPath()
  const locked = await withLedgerLock(file, () => {
    const ledger = readLedger(file)
    const dropped = ledger.claims.filter(
      c => c.taskId === task && c.phase !== 'done' && (slice === undefined || c.slice === slice),
    )
    if (dropped.length === 0 && slice !== undefined && waitsOnRun(ledger, task, slice, readPlan)) {
      writeLedger(file, releaseSlice(ledger, ledger.claims, task, slice))
      return { dropped, hold: undefined, unclaimed: true }
    }
    if (dropped.length === 0 && slice === undefined && slicesReleasedUnclaimed(ledger, task)) {
      writeLedger(file, withoutSliceReleases(ledger, task))
      return { dropped, hold: undefined, reseedable: true }
    }
    if (dropped.length === 0) return { dropped, hold: undefined }
    const claims = ledger.claims.filter(c => !dropped.includes(c))
    if (slice !== undefined) {
      writeLedger(file, releaseSlice(ledger, claims, task, slice))
      return { dropped, hold: undefined }
    }
    const record = { n: (ledger.releases?.[task]?.n ?? 0) + 1, at: now.toISOString() }
    writeLedger(file, {
      ...withoutSliceReleases(ledger, task),
      claims,
      releases: { ...ledger.releases, [task]: record },
    })
    return { dropped, hold: record }
  })
  if (!locked.ran) return refusedReport(`a tick holds the ledger lock (pid ${locked.holder}); try again`)
  const { dropped, hold } = locked.value
  const what = slice === undefined ? task : `${task} slice ${slice}`
  if ('unclaimed' in locked.value)
    return { ok: true, lines: [`released ${what}, which had no claim; the task no longer waits on it`] }
  if ('reseedable' in locked.value)
    return {
      ok: true,
      lines: [`released ${task}, whose slices were released with none held; it can be seeded again`],
    }
  if (dropped.length === 0) return refusedReport(`no held claim on ${what}`)
  const lines: string[] = []
  for (const claim of dropped) lines.push(describeClaim(claim), ...(await retireNames(claim, retire)))
  if (hold !== undefined)
    lines.push(`released ${hold.n} times; held until ${new Date(heldUntil(hold)).toISOString()}`)
  return { ok: true, lines }
}

/**
 * One slice's release: the task's other slices keep their claims, the task stays seeded, and the dropped
 * slice no longer gates its dependents. No backoff is counted, since that would hold the other slices back.
 */
function releaseSlice(ledger: Ledger, claims: Claim[], task: string, slice: string): Ledger {
  const released = [...new Set([...(ledger.slicesReleased?.[task] ?? []), slice])]
  return { ...ledger, claims, slicesReleased: { ...ledger.slicesReleased, [task]: released } }
}

/**
 * CC-1240: every slice claim of the task is done, and the plan's slice has no claim but an off-ledger run that
 * never opened a PR. Releasing it is the only way the task stops waiting on that run. With no plan reader, none is.
 */
function waitsOnRun(ledger: Ledger, task: string, slice: string, readPlan?: PlanReader): boolean {
  const claims = ledger.claims.filter(c => c.taskId === task && c.slice !== undefined)
  const parent = claims[0]
  if (readPlan === undefined || parent === undefined || claims.some(c => c.phase !== 'done')) return false
  return pendingOffLedger(ledger, readPlan)(parent.initiative, task).includes(slice)
}

/**
 * A whole-task release lets the task be seeded again. CC-1256: so does one with no held claim, which only
 * clears the released slices and counts no backoff, since no agent was dropped.
 */
function withoutSliceReleases(ledger: Ledger, task: string): Ledger {
  const { slicesReleased: all, ...rest } = ledger
  const { [task]: _cleared, ...kept } = all ?? {}
  return Object.keys(kept).length === 0 ? rest : { ...rest, slicesReleased: kept }
}

/**
 * CC-978: records a hand-dispatched PR on a queued slice, so the tick never dispatches the slice and
 * finishes it when the PR merges. Refused for a claim that is not queued or a PR Shepherd cannot name.
 */
export async function linkSlicePr(task: string, slice: string, pr: string): Promise<Report> {
  if (shepherdTarget(pr) === undefined)
    return refusedReport(`${pr} is not a GitHub PR (owner/repo#n or its URL)`)
  const file = burndownLedgerPath()
  const locked = await withLedgerLock(file, () => {
    const ledger = readLedger(file)
    const claim = ledger.claims.find(c => c.taskId === task && c.slice === slice && c.phase !== 'done')
    if (claim?.phase !== 'queued') return claim?.phase ?? 'no held claim'
    writeLedger(file, { ...ledger, claims: ledger.claims.map(c => (c === claim ? { ...c, pr } : c)) })
    return undefined
  })
  if (!locked.ran) return refusedReport(`a tick holds the ledger lock (pid ${locked.holder}); try again`)
  if (locked.value !== undefined)
    return refusedReport(
      `${task} slice ${slice} is not queued (${locked.value}); only a queued slice takes a link`,
    )
  return { ok: true, lines: [`linked ${task} slice ${slice} to ${pr}; the tick will not dispatch it`] }
}
