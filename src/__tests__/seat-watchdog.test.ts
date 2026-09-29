import { describe, expect, it } from 'vitest'
import type { BudgetRead } from '../agents/budget.js'
import {
  charterOwnerSeat,
  charterSeats,
  isSeatName,
  parsePools,
  parseSeat,
  type Pool,
} from '../agents/seats/charter.js'
import {
  FIRE_CAP,
  MAX_RUN_GAP_MS,
  accountReading,
  decide,
  poolBudget,
  runningImplementers,
  type Observation,
  type SeatAgent,
  type SeatState,
} from '../agents/seats/watchdog.js'

const CHARTER = `---
schema: autonomy-charter/v1
seats: [hjewkes-surplus, titan-coord]
pools:               # billing pools
  claude:  {config_dir: /Users/o/.claude, human_uses: true, reserve_seven_day: 35, ceiling_five_hour: 70, per_day_points: 13}
  agents:  {config_dir: ~/.claude-profiles/agents, human_uses: false, reserve_seven_day: 25, night_reserve_seven_day: 10, ceiling_five_hour: 85}
  broken:  {human_uses: true, reserve_seven_day: 35}
---
# Autonomy charter
pools: not this one
`

const SEAT_FILE = `---
schema: autonomy-seat/v1
name: hjewkes-surplus
prefix: hs
role: owner                   # owns the autonomy system
pool: claude
spend:
  per_run_points: 6
  per_day_points: 10          # the claude pool's 13 per day
concurrency:
  implementers: 3
---
# hjewkes-surplus
`

const NOW = Date.parse('2026-09-29T06:53:00Z')
const OPEN = { open: true, reason: 'seven_day 19% vs line 65%, five_hour 41% vs ceiling 70%' }
const idle = (over: Partial<Observation> = {}): Observation => ({
  budget: OPEN,
  implementers: 0,
  eligible: 12,
  ...over,
})

describe('decide', () => {
  const recent: SeatState = { idleRuns: 1, at: NOW - 15 * 60_000 }
  const cases: [string, Observation, SeatState | undefined, boolean, number, RegExp][] = [
    ['a running implementer resets the count', idle({ implementers: 1 }), recent, false, 0, /1 implementer/],
    [
      'a closed budget resets the count',
      idle({ budget: { open: false, reason: 'over ceiling' } }),
      recent,
      false,
      0,
      /budget closed: over ceiling/,
    ],
    [
      'an unreadable scorer never counts as work',
      idle({ eligible: undefined }),
      recent,
      false,
      0,
      /unavailable/,
    ],
    ['no eligible work resets the count', idle({ eligible: 0 }), recent, false, 0, /no eligible work/],
    ['the first idle run only counts', idle(), undefined, false, 1, /idle run 1 of 2/],
    [
      'the second consecutive idle run fires',
      idle(),
      recent,
      true,
      0,
      /0 implementers, budget open .*12 eligible/,
    ],
    [
      'an idle run after a long gap starts over',
      idle(),
      { idleRuns: 1, at: NOW - MAX_RUN_GAP_MS - 1 },
      false,
      1,
      /idle run 1/,
    ],
    [
      'an idle run exactly at the gap limit is consecutive',
      idle(),
      { idleRuns: 1, at: NOW - MAX_RUN_GAP_MS },
      true,
      0,
      /eligible$/,
    ],
  ]
  it.each(cases)('%s', (_name, obs, previous, fire, idleRuns, reason) => {
    const decision = decide(obs, previous, NOW)
    expect(decision.fire).toBe(fire)
    expect(decision.next).toMatchObject({ idleRuns, at: NOW })
    expect(decision.reason).toMatch(reason)
  })

  it('never wakes a held seat, even on its second idle run', () => {
    const decision = decide(idle({ hold: 'seat logged "BUDGET-PAUSE five_hour 71%"' }), recent, NOW)
    expect(decision.fire).toBe(false)
    expect(decision.reason).toMatch(/^held: seat logged "BUDGET-PAUSE/)
  })
})

describe('decide fire cap', () => {
  const MIN = 60_000
  /** Idle runs every 15 minutes from `start`, feeding each decision's state into the next. */
  function run(count: number, activityAt?: (at: number) => number | undefined, cap?: number): boolean[] {
    let state: SeatState | undefined
    return Array.from({ length: count }, (_, i) => {
      const at = NOW + i * 15 * MIN
      const activity = activityAt?.(at)
      const decision = decide(idle(activity === undefined ? {} : { activityAt: activity }), state, at, cap)
      state = decision.next
      return decision.fire
    })
  }
  const fireCount = (fires: boolean[]): number => fires.filter(Boolean).length

  it(`stops after ${FIRE_CAP} wakes that bring no implementer`, () => {
    const fires = run(12)
    expect(fireCount(fires)).toBe(FIRE_CAP)
    expect(fires.slice(0, 4)).toEqual([false, true, false, true])
  })

  it('reports the cap as the reason while it holds', () => {
    const state: SeatState = { idleRuns: 1, at: NOW - 15 * MIN, fires: 2, lastFireAt: NOW - 30 * MIN }
    const decision = decide(idle(), state, NOW)
    expect(decision.fire).toBe(false)
    expect(decision.reason).toMatch(/^fire cap: 2 wake\(s\) with no implementer/)
    expect(decision.next).toMatchObject({ fires: 2, lastFireAt: NOW - 30 * MIN })
  })

  it('fires again once the seat writes a log line after the last wake', () => {
    const state: SeatState = { idleRuns: 1, at: NOW - 15 * MIN, fires: 2, lastFireAt: NOW - 30 * MIN }
    const decision = decide(idle({ activityAt: NOW - 20 * MIN }), state, NOW)
    expect(decision.fire).toBe(true)
    expect(decision.next).toMatchObject({ fires: 1, lastFireAt: NOW })
  })

  it('stays capped when the seat last wrote before the wake', () => {
    const state: SeatState = { idleRuns: 1, at: NOW - 15 * MIN, fires: 2, lastFireAt: NOW - 30 * MIN }
    expect(decide(idle({ activityAt: NOW - 31 * MIN }), state, NOW).fire).toBe(false)
  })

  it('resets when an implementer appears', () => {
    const state: SeatState = { idleRuns: 0, at: NOW - 15 * MIN, fires: 2, lastFireAt: NOW - 30 * MIN }
    expect(decide(idle({ implementers: 1 }), state, NOW).next.fires).toBe(0)
  })

  it('honours a caller cap', () => {
    expect(fireCount(run(12, undefined, 1))).toBe(1)
  })
})

describe('runningImplementers', () => {
  const agent = (over: Partial<SeatAgent>): SeatAgent => ({
    name: 'hs-cc-1-x',
    profile: 'implementer',
    state: 'live',
    spawnedBy: 'someone',
    ...over,
  })
  const seat = { name: 'hjewkes-surplus', prefix: 'hs' }
  const cases: [string, SeatAgent, boolean][] = [
    ['a live implementer under the seat prefix', agent({}), true],
    [
      'a bd-implementer spawned by the seat under another name',
      agent({ name: 'cc197-x', profile: 'bd-implementer', spawnedBy: 'hjewkes-surplus' }),
      true,
    ],
    ['a starting implementer', agent({ state: 'spawning' }), true],
    ['a detached implementer', agent({ state: 'detached' }), true],
    ['an exited implementer waiting on review', agent({ state: 'exited' }), false],
    ['a reviewer', agent({ profile: 'reviewer' }), false],
    ['another seat whose prefix starts the same', agent({ name: 'hsx-cc-1' }), false],
  ]
  it.each(cases)('%s', (_name, a, counted) => {
    expect(runningImplementers([a], seat)).toEqual(counted ? [a.name] : [])
  })
})

const found = (rateLimits: Record<string, { used_pct: number; resets_at?: number }>): BudgetRead => ({
  found: true,
  path: '/x',
  age_seconds: 30,
  stale: false,
  budget: {
    session_id: 's',
    written_at: 0,
    context: { exceeds_200k: false },
    cost: {},
    rate_limits: rateLimits,
  },
})

describe('accountReading', () => {
  it('reads a window whose reset has passed as 0', () => {
    const read = found({
      five_hour: { used_pct: 41, resets_at: NOW / 1000 - 1 },
      seven_day: { used_pct: 19 },
    })
    expect(accountReading(read, NOW)).toEqual({ ageSeconds: 30, fiveHour: 0, sevenDay: 19 })
  })

  it('keeps a window whose reset is still ahead', () => {
    const read = found({
      five_hour: { used_pct: 41, resets_at: NOW / 1000 + 60 },
      seven_day: { used_pct: 19 },
    })
    expect(accountReading(read, NOW)).toEqual({ ageSeconds: 30, fiveHour: 41, sevenDay: 19 })
  })

  it('has no reading when no status file was found', () => {
    expect(accountReading({ found: false, path: '/x', reason: 'no_file' }, NOW)).toBeUndefined()
  })
})

describe('poolBudget', () => {
  const pools = parsePools(CHARTER, '/Users/o')
  const claude = pools.get('claude') as Pool
  const at = new Date(NOW)
  const cases: [string, Pool | undefined, { fiveHour?: number; sevenDay?: number } | undefined, boolean][] = [
    ['open below both stops', claude, { fiveHour: 41, sevenDay: 19 }, true],
    ['closed at the five-hour ceiling', claude, { fiveHour: 70, sevenDay: 19 }, false],
    ['closed at the seven-day reserve line', claude, { fiveHour: 10, sevenDay: 65 }, false],
    ['closed without a reading', claude, undefined, false],
    ['closed for a pool the charter does not define', undefined, { fiveHour: 0, sevenDay: 0 }, false],
  ]
  it.each(cases)('%s', (_name, pool, reading, open) => {
    const verdict = poolBudget(pool, reading === undefined ? undefined : { ageSeconds: 0, ...reading }, at)
    expect(verdict.open).toBe(open)
  })

  it('holds a human-free pool to 70 on five_hour, because owner presence is unknown', () => {
    const agents = pools.get('agents')
    expect(poolBudget(agents, { ageSeconds: 0, fiveHour: 75, sevenDay: 10 }, at).open).toBe(false)
  })
})

describe('charter and seat parsing', () => {
  it('reads each pool with its config dir, stops and night reserve', () => {
    const pools = parsePools(CHARTER, '/Users/o')
    expect(pools.get('claude')).toEqual({
      name: 'claude',
      configDir: '/Users/o/.claude',
      rule: { reserve_seven_day: 35, ceiling_five_hour: 70 },
      perDayPoints: 13,
    })
    expect(pools.get('agents')).toEqual({
      name: 'agents',
      configDir: '/Users/o/.claude-profiles/agents',
      rule: { reserve_seven_day: 25, ceiling_five_hour: 85, night: { reserve_seven_day: 10 } },
    })
  })

  it('drops a pool missing its config dir or a stop, so its gate stays closed', () => {
    expect(parsePools(CHARTER, '/Users/o').has('broken')).toBe(false)
  })

  it('lists the charter seats and reads a seat prefix and pool', () => {
    expect(charterSeats(CHARTER)).toEqual(['hjewkes-surplus', 'titan-coord'])
    expect(parseSeat('hjewkes-surplus', SEAT_FILE)).toEqual({
      name: 'hjewkes-surplus',
      prefix: 'hs',
      pool: 'claude',
      spend: { perRunPoints: 6, perDayPoints: 10 },
    })
  })

  it('reads a seat without a spend block as having no seat spend stops', () => {
    expect(parseSeat('x', '---\nprefix: x\npool: claude\n---\n')?.spend).toEqual({})
  })

  it('reads the owner seat from the charter', () => {
    expect(charterOwnerSeat('---\nowner_seat: hjewkes-surplus\n---\n')).toBe('hjewkes-surplus')
  })

  it.each([
    ['hjewkes-surplus', true],
    ['../etc', false],
    ['a/b', false],
    ['', false],
  ])('treats %j as a seat name: %s', (name, ok) => {
    expect(isSeatName(name)).toBe(ok)
  })

  it('refuses a seat file without a prefix', () => {
    expect(parseSeat('x', '---\npool: claude\n---\n')).toBeUndefined()
  })
})
