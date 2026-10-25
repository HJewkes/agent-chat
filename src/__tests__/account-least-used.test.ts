import { describe, expect, it } from 'vitest'
import type { AccountUsage } from '../agents/account-budget.js'
import { DEFAULT_ROTATION, leastUsedText, pickLeastUsed } from '../agents/account-rotation.js'

/** TP-4213: the role-agnostic least-used pick, over fake readings. */

const root = '/synthetic/.claude-profiles'
const dirOf = (account: string): string => `${root}/${account}`

interface Fake {
  fiveHour?: number
  stale?: boolean
  authFail?: boolean
}

const usage = (account: string, sevenDay: number | null, fake: Fake = {}): AccountUsage => ({
  account,
  config_dir: dirOf(account),
  source: sevenDay === null ? null : 'usage-poller',
  five_hour: fake.fiveHour === undefined ? null : { used_pct: fake.fiveHour },
  seven_day: sevenDay === null ? null : { used_pct: sevenDay },
  age_seconds: sevenDay === null ? null : fake.stale ? 420 : 60,
  stale: fake.stale ?? false,
  auth_fail: fake.authFail ?? false,
})

const chosenDir = (pick: ReturnType<typeof pickLeastUsed>): string | undefined =>
  pick.ok ? pick.dir : undefined

describe('the least-used account a spawn asks for', () => {
  it('gives a tie to the spawner’s own account', () => {
    const usages = [usage('alpha', 40), usage('beta', 40), usage('gamma', 60)]

    expect(chosenDir(pickLeastUsed(usages, DEFAULT_ROTATION, { preferDir: dirOf('beta') }))).toBe(
      dirOf('beta'),
    )
  })

  it('gives a tie to the earlier account when the spawner’s is not among the tied', () => {
    const usages = [usage('alpha', 40), usage('beta', 40), usage('gamma', 60)]

    expect(chosenDir(pickLeastUsed(usages, DEFAULT_ROTATION, { preferDir: dirOf('gamma') }))).toBe(
      dirOf('alpha'),
    )
    expect(chosenDir(pickLeastUsed(usages, DEFAULT_ROTATION))).toBe(dirOf('alpha'))
  })

  it('never prefers a stale lower reading over a fresh higher one', () => {
    const usages = [usage('alpha', 5, { stale: true }), usage('beta', 40)]

    expect(chosenDir(pickLeastUsed(usages, DEFAULT_ROTATION))).toBe(dirOf('beta'))
  })

  it('ranks by the fuller window, so a busy five_hour loses to a quieter account', () => {
    const usages = [usage('alpha', 10, { fiveHour: 85 }), usage('beta', 30, { fiveHour: 20 })]

    expect(chosenDir(pickLeastUsed(usages, DEFAULT_ROTATION))).toBe(dirOf('beta'))
  })

  it('refuses with every reading when no account qualifies', () => {
    const usages = [
      usage('alpha', 93),
      usage('beta', 5, { stale: true }),
      usage('gamma', 10, { authFail: true }),
    ]
    const pick = pickLeastUsed(usages, DEFAULT_ROTATION)

    expect(pick.ok).toBe(false)
    expect(pick.ok ? '' : pick.reason).toBe(
      'no account has a fresh reading under the 90% ceiling ' +
        '(least-used; max(5h,7d): alpha over ceiling 93% [5h n/a 7d 93], beta stale 420s, gamma login failed)',
    )
  })

  it('skips an excluded account', () => {
    const usages = [usage('alpha', 10), usage('beta', 30)]

    expect(chosenDir(pickLeastUsed(usages, { ...DEFAULT_ROTATION, exclude: ['alpha'] }))).toBe(dirOf('beta'))
  })

  it('skips the lowest candidate when the spawn’s own gates refuse it', () => {
    const usages = [usage('alpha', 10), usage('beta', 30)]
    const pick = pickLeastUsed(usages, DEFAULT_ROTATION, { refuses: dir => dir === dirOf('alpha') })

    expect(chosenDir(pick)).toBe(dirOf('beta'))
    expect(pick.record.readings.find(r => r.account === 'alpha')?.state).toBe('refused')
  })

  it('names the choice and every reading it compared', () => {
    const usages = [
      usage('alpha', 40, { fiveHour: 72 }),
      usage('beta', 31, { fiveHour: 12 }),
      usage('gamma', 5, { stale: true }),
      usage('delta', 40, { fiveHour: 93 }),
      usage('epsilon', null),
    ]

    expect(leastUsedText(pickLeastUsed(usages, DEFAULT_ROTATION).record)).toBe(
      'beta (least-used; max(5h,7d): alpha 72% [5h 72 7d 40], beta 31% [5h 12 7d 31], ' +
        'gamma stale 420s, delta over ceiling 93% [5h 93 7d 40], epsilon no reading)',
    )
  })
})

describe('an account the spawn names', () => {
  it('launches on it over a less-used account', () => {
    const usages = [usage('alpha', 10), usage('beta', 80)]

    expect(chosenDir(pickLeastUsed(usages, DEFAULT_ROTATION, { explicit: 'beta' }))).toBe(dirOf('beta'))
  })

  it('matches an absolute config dir', () => {
    const usages = [usage('alpha', 10), usage('beta', 80)]

    expect(chosenDir(pickLeastUsed(usages, DEFAULT_ROTATION, { explicit: dirOf('beta') }))).toBe(
      dirOf('beta'),
    )
  })

  it('launches on an excluded account, since exclusion only steers the ranking', () => {
    const usages = [usage('alpha', 10), usage('beta', 30)]
    const config = { ...DEFAULT_ROTATION, exclude: ['beta'] }

    expect(chosenDir(pickLeastUsed(usages, config, { explicit: 'beta' }))).toBe(dirOf('beta'))
  })

  it('refuses one at the ceiling in either window', () => {
    const usages = [usage('alpha', 10), usage('beta', 20, { fiveHour: 90 })]
    const pick = pickLeastUsed(usages, DEFAULT_ROTATION, { explicit: 'beta' })

    expect(pick.ok).toBe(false)
    expect(pick.ok ? '' : pick.reason).toMatch(/^beta is at or over the 90% ceiling \(explicit; /)
  })

  it('refuses one whose login failed', () => {
    const pick = pickLeastUsed([usage('alpha', 10, { authFail: true })], DEFAULT_ROTATION, {
      explicit: 'alpha',
    })

    expect(pick.ok ? '' : pick.reason).toMatch(/^alpha's login failed/)
  })

  it('launches on a stale one with a warning that names the reading’s age', () => {
    const pick = pickLeastUsed([usage('alpha', 10), usage('beta', 5, { stale: true })], DEFAULT_ROTATION, {
      explicit: 'beta',
    })

    expect(chosenDir(pick)).toBe(dirOf('beta'))
    expect(pick.record.warning).toBe("beta's reading is stale 420s")
    expect(leastUsedText(pick.record)).toMatch(
      /^beta \(explicit; .*; warning: beta's reading is stale 420s\)$/,
    )
  })

  it('refuses an unknown name and lists the known ones', () => {
    const pick = pickLeastUsed([usage('alpha', 10), usage('beta', 20)], DEFAULT_ROTATION, {
      explicit: 'zeta',
    })

    expect(pick.ok ? '' : pick.reason).toBe('unknown account zeta; known: alpha, beta')
  })
})
