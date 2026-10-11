import { burndownLedgerPath } from '../../paths.js'
import { heldUntil } from '../../agents/burndown/backoff.js'
import { shepherdTarget } from '../../agents/burndown/shepherd.js'
import { readLedger, withLedgerLock, writeLedger, type Claim } from '../../agents/burndown/ledger.js'
import { releaseHeld } from '../../agents/burndown/release.js'
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
 * one's spawned agents; a refused retire never keeps a claim. A release with no held claim changes nothing.
 * With `slice`, only that slice's claim is dropped (CC-978); see `releaseHeld`.
 */
export async function releaseTask(
  task: string,
  retire: RetireCall,
  now = new Date(),
  slice?: string,
): Promise<Report> {
  const file = burndownLedgerPath()
  const locked = await withLedgerLock(file, () => {
    const released = releaseHeld(readLedger(file), task, now, slice)
    if (released.dropped.length > 0) writeLedger(file, released.ledger)
    return released
  })
  if (!locked.ran) return refusedReport(`a tick holds the ledger lock (pid ${locked.holder}); try again`)
  const { dropped, hold } = locked.value
  const what = slice === undefined ? task : `${task} slice ${slice}`
  if (dropped.length === 0) return refusedReport(`no held claim on ${what}`)
  const lines: string[] = []
  for (const claim of dropped) lines.push(describeClaim(claim), ...(await retireNames(claim, retire)))
  if (hold !== undefined)
    lines.push(`released ${hold.n} times; held until ${new Date(heldUntil(hold)).toISOString()}`)
  return { ok: true, lines }
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
