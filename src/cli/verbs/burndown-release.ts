import { burndownLedgerPath } from '../../paths.js'
import { readLedger, withLedgerLock, writeLedger, type Claim } from '../../agents/burndown/ledger.js'
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

/** Drops every held claim on `task`, then retires each one's spawned agents; a refused retire never keeps a claim. */
export async function releaseTask(task: string, retire: RetireCall): Promise<Report> {
  const file = burndownLedgerPath()
  const locked = await withLedgerLock(file, () => {
    const ledger = readLedger(file)
    const dropped = ledger.claims.filter(c => c.taskId === task && c.phase !== 'done')
    writeLedger(file, { ...ledger, claims: ledger.claims.filter(c => !dropped.includes(c)) })
    return dropped
  })
  if (!locked.ran) return refusedReport(`a tick holds the ledger lock (pid ${locked.holder}); try again`)
  if (locked.value.length === 0) return refusedReport(`no held claim on ${task}`)
  const lines: string[] = []
  for (const claim of locked.value) lines.push(describeClaim(claim), ...(await retireNames(claim, retire)))
  return { ok: true, lines }
}
