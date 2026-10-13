import os from 'node:os'
import path from 'node:path'
import { readAccountBudget, type BudgetRead } from './budget.js'
import { DEFAULT_REVIEWER_CEILING, type ReviewerAccountRead } from './reviewer-account-gate.js'
import { parsePools } from './seats/charter.js'
import { readText } from './seats/io.js'
import { poolForConfigDir } from './seats/spawn-gate-read.js'

export interface ReviewerAccountReadDeps {
  readBudget: (configDir: string, nowMs: number) => BudgetRead
  home: string
}

const defaultDeps: ReviewerAccountReadDeps = { readBudget: readAccountBudget, home: os.homedir() }

/**
 * The pool's `ceiling_five_hour` as written. The owner-present lowering is not applied: a reviewer
 * is not the work the owner competes with. A dir no pool names, or an unreadable charter, gets 100.
 */
function ceilingFor(
  root: string,
  configDir: string,
  home: string,
): Pick<ReviewerAccountRead, 'ceiling' | 'pool'> {
  const charter = readText(path.join(root, 'charter.md'))
  const pool = charter === undefined ? undefined : poolForConfigDir(parsePools(charter, home), configDir)
  return pool === undefined
    ? { ceiling: DEFAULT_REVIEWER_CEILING }
    : { ceiling: pool.rule.ceiling_five_hour, pool: pool.name }
}

/** CC-1078: the billed account's five_hour window and the ceiling a reviewer spawn into it is held to. */
export function readReviewerAccount(
  root: string,
  configDir: string,
  nowMs: number,
  deps: ReviewerAccountReadDeps = defaultDeps,
): ReviewerAccountRead {
  const base = { configDir, ...ceilingFor(root, configDir, deps.home) }
  const read = deps.readBudget(configDir, nowMs)
  if (!read.found) return { ...base, miss: read.reason }
  const window = read.budget.rate_limits.five_hour
  if (window === undefined) return { ...base, miss: 'no five_hour window' }
  const resetsAt = window.resets_at === undefined ? {} : { resetsAtMs: window.resets_at * 1000 }
  return { ...base, window: { usedPct: window.used_pct, ageSeconds: read.age_seconds, ...resetsAt } }
}
