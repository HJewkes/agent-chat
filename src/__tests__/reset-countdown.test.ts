import { describe, expect, it } from 'vitest'
import { formatUsageWindow } from '../agents/reset-countdown.js'
import { accountUsageLines, formatBudget, type AccountReading } from '../agents/budget.js'

const ZONE = 'America/Denver'
// 2026-10-24T22:32:00Z, 16:32 MDT.
const NOW_MS = Date.UTC(2026, 9, 24, 22, 32)
const NOW_S = NOW_MS / 1000
// 2026-10-25T00:00:00Z, 18:00 MDT, 1h28m out.
const RESET_S = Date.UTC(2026, 9, 25, 0, 0) / 1000

const account = (rateLimits: Record<string, unknown>): AccountReading =>
  ({
    name: 'agents',
    config_dir: '/synthetic/agents',
    read: {
      found: true,
      age_seconds: 230,
      stale: false,
      budget: { session_id: 's1', written_at: NOW_S - 230, context: {}, cost: {}, rate_limits: rateLimits },
    },
  }) as AccountReading

describe('a usage window with its reset', () => {
  it('shows the local reset time and the countdown', () => {
    expect(formatUsageWindow('seven_day', { used_pct: 90, resets_at: RESET_S }, NOW_MS, ZONE)).toBe(
      'seven_day 90% (resets 18:00 MDT, in 1h28m)',
    )
  })

  it('shows minutes alone under an hour out', () => {
    expect(formatUsageWindow('five_hour', { used_pct: 26, resets_at: NOW_S + 45 * 60 }, NOW_MS, ZONE)).toBe(
      'five_hour 26% (resets 17:17 MDT, in 45m)',
    )
  })

  it('names the weekday and counts days for a reset more than a day out', () => {
    const reset = RESET_S + (2 * 24 + 1) * 3600
    expect(formatUsageWindow('seven_day', { used_pct: 12, resets_at: reset }, NOW_MS, ZONE)).toBe(
      'seven_day 12% (resets Mon 19:00 MDT, in 2d2h)',
    )
  })

  it('says the reset is due once it has passed', () => {
    expect(formatUsageWindow('five_hour', { used_pct: 99, resets_at: NOW_S - 60 }, NOW_MS, ZONE)).toBe(
      'five_hour 99% (reset due)',
    )
  })

  it('adds nothing when the reading carries no resets_at', () => {
    expect(formatUsageWindow('five_hour', { used_pct: 21.44 }, NOW_MS, ZONE)).toBe('five_hour 21.4%')
  })
})

describe('the readouts that print usage windows', () => {
  const limits = { five_hour: { used_pct: 26, resets_at: NOW_S + 3600 }, seven_day: { used_pct: 90, resets_at: RESET_S } }

  it('agent_list header carries each window’s countdown', () => {
    const line = accountUsageLines([account(limits)], undefined, NOW_MS)
    expect(line).toMatch(/^Account usage on agents \(230s old\): five_hour 26% \(resets \d\d:\d\d \S+, in 1h0m\), /)
    expect(line).toMatch(/seven_day 90% \(resets \d\d:\d\d \S+, in 1h28m\)\.$/)
  })

  it('session_budget’s account line carries the same countdown', () => {
    const read = account(limits).read as Extract<AccountReading['read'], { found: true }>
    const out = formatBudget('You', read, account(limits), NOW_MS)
    expect(out).toMatch(/^Account on agents \(230s old\): .*seven_day 90% \(resets \d\d:\d\d \S+, in 1h28m\)\.$/m)
  })

  it('a stale reading keeps its STALE line and shows no windows', () => {
    const stale = account(limits)
    if (stale.read.found) stale.read.age_seconds = 20 * 60
    expect(accountUsageLines([stale], undefined, NOW_MS)).toBe(
      'Account usage on agents: STALE — newest reading is 1200s old, not a current figure.',
    )
  })
})
