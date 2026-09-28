import fs from 'node:fs'
import { budgetDir, readBudget, type BudgetRead } from '../agents/budget.js'
import type { AccountSpend, Reading } from './types.js'

/**
 * Per account, the freshest status-line reading and the newest one written at
 * or before the window's start. The per-session files are the only history
 * agent-chat keeps, so "then" is whichever session last redrew before the
 * cutoff, and is absent when those files were pruned.
 */

/** Older than this, a reading is shown as stale rather than as the account's current use. */
export const DIGEST_STALE_MS = 30 * 60_000

type Found = Extract<BudgetRead, { found: true }>

function readingsUnder(dir: string, now: number): Found[] {
  let files: string[]
  try {
    files = fs.readdirSync(budgetDir(dir)).filter(name => name.endsWith('.json'))
  } catch {
    return []
  }
  return files
    .map(name => readBudget(name.slice(0, -'.json'.length), now, dir))
    .filter((read): read is Found => read.found)
}

const toReading = (read: Found): Reading => {
  const { seven_day, five_hour } = read.budget.rate_limits
  return {
    writtenAt: read.budget.written_at * 1000,
    ...(seven_day === undefined ? {} : { sevenDay: seven_day.used_pct }),
    ...(five_hour === undefined ? {} : { fiveHour: five_hour.used_pct }),
  }
}

const newest = (reads: Found[]): Found | undefined =>
  reads.reduce<Found | undefined>(
    (a, b) => (a === undefined || b.budget.written_at > a.budget.written_at ? b : a),
    undefined,
  )

export function accountSpend(account: string, dir: string, sinceMs: number, now: number): AccountSpend {
  const reads = readingsUnder(dir, now).filter(
    r => r.budget.rate_limits.seven_day ?? r.budget.rate_limits.five_hour,
  )
  const latest = newest(reads)
  const before = newest(reads.filter(r => r.budget.written_at * 1000 <= sinceMs))
  return {
    account,
    stale: latest === undefined || now - latest.budget.written_at * 1000 > DIGEST_STALE_MS,
    ...(latest === undefined ? {} : { now: toReading(latest) }),
    ...(before === undefined ? {} : { then: toReading(before) }),
  }
}
