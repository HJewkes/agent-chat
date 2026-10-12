import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { BudgetRead, BudgetWindow } from '../agents/budget.js'
import { readReviewerAccount, type ReviewerAccountReadDeps } from '../agents/reviewer-account-gate-read.js'
import {
  REVIEWER_ACCOUNT_LIMIT,
  resetWords,
  reviewerAccountGate,
  type ReviewerAccountRead,
} from '../agents/reviewer-account-gate.js'

/** CC-1078: refuse a reviewer spawn into an account past its five_hour ceiling. Synthetic dirs, injected time. */
const NOW = Date.UTC(2026, 9, 11, 23, 30)
const HOUR = 60 * 60 * 1000
const IN_AN_HOUR = NOW + HOUR

/** Shepherd's `RESET` from titan-platform `products/factory/src/shepherd/account-limit.ts:40`, copied so a wording change fails here. */
const SHEPHERD_RESET =
  /\bresets?\s+(?:at\s+)?(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)\s]+)\)/i

const read = (
  usedPct: number,
  extra: Partial<ReviewerAccountRead> = {},
  resetsAtMs: number | null = IN_AN_HOUR,
): ReviewerAccountRead => ({
  configDir: '/synthetic/rv',
  ceiling: 85,
  pool: 'reviews',
  window: { usedPct, ageSeconds: 30, ...(resetsAtMs === null ? {} : { resetsAtMs }) },
  ...extra,
})

describe('the reviewer account gate', () => {
  it('refuses a reading over the ceiling and names the reset in Shepherd and ISO form', () => {
    const verdict = reviewerAccountGate(read(90), NOW)

    expect(verdict.allow).toBe(false)
    expect(verdict.resetsAt).toBe(IN_AN_HOUR)
    expect(verdict.reason).toBe(
      'reviewer account limit: account /synthetic/rv five_hour 90% at or over ceiling 85% (reviews); ' +
        'resets Oct 12 at 12:30am (UTC) [2026-10-12T00:30:00.000Z]',
    )
  })

  it('refuses a reading exactly at the ceiling', () => {
    expect(reviewerAccountGate(read(85), NOW).allow).toBe(false)
  })

  it('allows a reading just under the ceiling', () => {
    expect(reviewerAccountGate(read(84), NOW)).toEqual({
      allow: true,
      reason: 'five_hour 84% under ceiling 85%',
    })
  })

  it('trusts an old reading over the ceiling while its window has not reset', () => {
    const old = read(95, { window: { usedPct: 95, ageSeconds: 3 * 3600, resetsAtMs: IN_AN_HOUR } })

    expect(reviewerAccountGate(old, NOW).allow).toBe(false)
  })

  it('allows a stale reading that carries no reset time', () => {
    const stale = read(95, { window: { usedPct: 95, ageSeconds: 20 * 60 } })

    expect(reviewerAccountGate(stale, NOW)).toEqual({ allow: true, reason: expect.stringContaining('stale') })
  })

  it('refuses a fresh reading with no reset time and says the reset is unreported', () => {
    const verdict = reviewerAccountGate(read(95, {}, null), NOW)

    expect(verdict.allow).toBe(false)
    expect(verdict.resetsAt).toBeUndefined()
    expect(verdict.reason).toMatch(/; reset time not reported$/)
  })

  it('allows a full window whose reset has passed', () => {
    expect(reviewerAccountGate(read(100, {}, NOW - 1), NOW)).toEqual({
      allow: true,
      reason: expect.stringContaining('five_hour window reset at'),
    })
  })

  it('allows an account with no reading and says why', () => {
    const missing: ReviewerAccountRead = { configDir: '/synthetic/rv', ceiling: 85, miss: 'no_file' }

    expect(reviewerAccountGate(missing, NOW)).toEqual({
      allow: true,
      reason: 'no five_hour reading: no_file',
    })
  })

  it('names the default ceiling when no charter pool bills the account', () => {
    const { pool: _pool, ...unpooled } = read(100, { ceiling: 100 })

    expect(reviewerAccountGate(unpooled, NOW).reason).toContain('ceiling 100% (no charter pool)')
  })

  it("writes a reset Shepherd's parser reads, with no trailing newline", () => {
    const { reason } = reviewerAccountGate(read(90), NOW)
    const match = SHEPHERD_RESET.exec(reason)

    expect(match?.slice(1)).toEqual(['Oct', '12', '12', '30', 'am', 'UTC'])
    expect(reason.endsWith('\n')).toBe(false)
    expect(REVIEWER_ACCOUNT_LIMIT).toBe('reviewer_account_limit')
  })

  it('writes afternoon and on-the-hour resets in twelve-hour form', () => {
    expect(resetWords(Date.UTC(2026, 0, 5, 12, 0))).toBe('Jan 5 at 12:00pm (UTC)')
    expect(resetWords(Date.UTC(2026, 11, 31, 18, 5))).toBe('Dec 31 at 6:05pm (UTC)')
  })
})

const CHARTER = `---
pools:
  reviews: {config_dir: ~/rv, human_uses: false, reserve_seven_day: 10, ceiling_five_hour: 80}
  shared: {config_dir: ~/shared, human_uses: true, reserve_seven_day: 10, ceiling_five_hour: 85}
---
# synthetic charter
`

describe('reading the reviewer account', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  const root = (charter: string | null = CHARTER): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-account-gate-'))
    dirs.push(dir)
    if (charter !== null) fs.writeFileSync(path.join(dir, 'charter.md'), charter)
    return dir
  }

  const found = (windows: Record<string, BudgetWindow>, age_seconds = 30): BudgetRead => ({
    found: true,
    path: '/synthetic/rv/status-cache',
    budget: {
      session_id: 's',
      written_at: NOW / 1000 - age_seconds,
      context: { exceeds_200k: false },
      cost: {},
      rate_limits: windows,
    },
    age_seconds,
    stale: false,
  })

  const deps = (result: BudgetRead, reads: string[] = []): ReviewerAccountReadDeps => ({
    home: '/synthetic',
    readBudget: (configDir): BudgetRead => {
      reads.push(configDir)
      return result
    },
  })

  it('takes the ceiling of the pool whose home-relative config_dir is the billed dir', () => {
    const reads: string[] = []
    const result = readReviewerAccount(
      root(),
      '/synthetic/rv/',
      NOW,
      deps(found({ five_hour: { used_pct: 82, resets_at: IN_AN_HOUR / 1000 } }), reads),
    )

    expect(reads).toEqual(['/synthetic/rv/'])
    expect(result).toEqual({
      configDir: '/synthetic/rv/',
      ceiling: 80,
      pool: 'reviews',
      window: { usedPct: 82, ageSeconds: 30, resetsAtMs: IN_AN_HOUR },
    })
    expect(reviewerAccountGate(result, NOW).allow).toBe(false)
  })

  it('holds a dir no pool names to 100', () => {
    const result = readReviewerAccount(
      root(),
      '/synthetic/other',
      NOW,
      deps(found({ five_hour: { used_pct: 99 } })),
    )

    expect(result).toEqual({
      configDir: '/synthetic/other',
      ceiling: 100,
      window: { usedPct: 99, ageSeconds: 30 },
    })
  })

  it('holds every dir to 100 when there is no charter, without throwing', () => {
    const result = readReviewerAccount(
      root(null),
      '/synthetic/rv',
      NOW,
      deps(found({ five_hour: { used_pct: 99 } })),
    )

    expect(result.ceiling).toBe(100)
    expect(result.pool).toBeUndefined()
  })

  it('reports a missing status cache as a miss', () => {
    const result = readReviewerAccount(
      root(),
      '/synthetic/rv',
      NOW,
      deps({ found: false, path: '/x', reason: 'no_file' }),
    )

    expect(result).toEqual({ configDir: '/synthetic/rv', ceiling: 80, pool: 'reviews', miss: 'no_file' })
    expect(reviewerAccountGate(result, NOW).allow).toBe(true)
  })

  it('reports a reading with no five_hour window as a miss', () => {
    const result = readReviewerAccount(
      root(),
      '/synthetic/rv',
      NOW,
      deps(found({ seven_day: { used_pct: 99 } })),
    )

    expect(result.miss).toBe('no five_hour window')
    expect(reviewerAccountGate(result, NOW).allow).toBe(true)
  })
})
