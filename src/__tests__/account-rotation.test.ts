import { describe, expect, it } from 'vitest'
import type { AccountUsage } from '../agents/account-budget.js'
import { DEFAULT_ROTATION, pickAccount, rotationText } from '../agents/account-rotation.js'

/** CC-1546: the pure pick. `spawn-account-rotation.test.ts` proves it is wired into a spawn. */

const root = '/synthetic/.claude-profiles'
const dirOf = (account: string): string => `${root}/${account}`

const usage = (account: string, usedPct: number | null, stale = false): AccountUsage => ({
  account,
  config_dir: dirOf(account),
  source: usedPct === null ? null : 'usage-poller',
  five_hour: null,
  seven_day: usedPct === null ? null : { used_pct: usedPct },
  age_seconds: usedPct === null ? null : stale ? 3600 : 60,
  stale,
  auth_fail: false,
})

describe('the account a worker spawn rotates to', () => {
  it('moves to a fresh account with a lower seven_day reading', () => {
    const pick = pickAccount(dirOf('alpha'), [usage('alpha', 70), usage('beta', 30)], DEFAULT_ROTATION)

    expect(pick.dir).toBe(dirOf('beta'))
    expect(pick.record).toMatchObject({ from: 'alpha', chosen: 'beta', rotated: true })
  })

  it('never prefers a stale lower reading over a fresh higher one', () => {
    const usages = [usage('alpha', 80), usage('beta', 5, true), usage('gamma', 50)]

    expect(pickAccount(dirOf('alpha'), usages, DEFAULT_ROTATION).dir).toBe(dirOf('gamma'))
  })

  it('keeps the resolved account when no reading is fresh', () => {
    const usages = [usage('alpha', 80, true), usage('beta', 5, true), usage('gamma', null)]
    const pick = pickAccount(dirOf('alpha'), usages, DEFAULT_ROTATION)

    expect(pick.dir).toBe(dirOf('alpha'))
    expect(pick.record.rotated).toBe(false)
  })

  it('never rotates to an account at or above the ceiling', () => {
    const usages = [usage('alpha', 95), usage('beta', 90), usage('gamma', 89)]

    expect(pickAccount(dirOf('alpha'), usages, DEFAULT_ROTATION).dir).toBe(dirOf('gamma'))
  })

  it('keeps the resolved account when every other is over the ceiling', () => {
    const usages = [usage('alpha', 95), usage('beta', 91)]

    expect(pickAccount(dirOf('alpha'), usages, DEFAULT_ROTATION).dir).toBe(dirOf('alpha'))
  })

  it('keeps the resolved account on a tie with the lowest', () => {
    const usages = [usage('beta', 40), usage('alpha', 40)]

    expect(pickAccount(dirOf('alpha'), usages, DEFAULT_ROTATION).dir).toBe(dirOf('alpha'))
  })

  it('never rotates to an excluded account, by name or by dir', () => {
    const usages = [usage('alpha', 70), usage('beta', 10), usage('gamma', 20), usage('delta', 60)]
    const config = { ...DEFAULT_ROTATION, exclude: ['beta', dirOf('gamma')] }

    expect(pickAccount(dirOf('alpha'), usages, config).dir).toBe(dirOf('delta'))
  })

  it('never rotates to an account whose login failed', () => {
    const usages = [usage('alpha', 70), { ...usage('beta', 10), auth_fail: true }]

    expect(pickAccount(dirOf('alpha'), usages, DEFAULT_ROTATION).dir).toBe(dirOf('alpha'))
  })

  it('names the choice and every reading it compared', () => {
    const usages = [usage('alpha', 72), usage('beta', 31), usage('gamma', 5, true), usage('delta', null)]

    expect(rotationText(pickAccount(dirOf('alpha'), usages, DEFAULT_ROTATION).record)).toBe(
      'beta (rotated from alpha; seven_day alpha 72%, beta 31%, gamma stale, delta no reading)',
    )
  })
})
