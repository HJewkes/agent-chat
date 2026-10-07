import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DISPATCH_COST,
  dayStart,
  RUN_CAP_MS,
  gatePool,
  pointsSpent,
  runStartAt,
  type AccountReading,
  type PoolGateInput,
  type PoolRule,
  type SevenDaySample,
} from '../agents/burndown/budget-gate.js'
import { loadPolicy, seatBudget } from '../agents/burndown/policy.js'

/** CC-204: charter section 4's budget stops for a seat on its pool, over synthetic pools and readings. */

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'autonomy-2026-09-29')
const MIN = 60_000
const HOUR = 60 * MIN
const at = (hour: number, minute = 0) => new Date(2026, 8, 29, hour, minute)

function budgetOf(seat: string) {
  const { charter, seat: policy } = loadPolicy(FIXTURE, seat)
  return seatBudget(charter, policy)
}

/** seat-b on pool-y: no human use, line 80 with no reset known, ceiling 80, 18 a day; seat caps 14 a run, 25 a day. */
const SEAT_B = budgetOf('seat-b')
/** seat-a on pool-x: human use, line 70, ceiling 75, 12 a day; seat caps 5 a run, 9 a day. */
const SEAT_A = budgetOf('seat-a')

interface Case {
  budget?: Pick<PoolGateInput, 'pool' | 'spend'>
  now?: Date
  fiveHour?: number
  sevenDay?: number
  history?: SevenDaySample[]
  runStartAt?: number
  ownerTypedMinAgo?: number
  ageSeconds?: number
  maxReadingAgeSeconds?: number
  dispatched?: number
  /** Epoch ms the pool's seven_day window resets. */
  resetsAt?: number
}

function gate(c: Case) {
  const now = c.now ?? at(15)
  const sevenDay = c.sevenDay ?? 40
  const budget = c.budget ?? SEAT_B
  return gatePool(
    {
      pool: budget.pool,
      spend: budget.spend,
      reading: {
        fiveHour: c.fiveHour ?? 10,
        sevenDay,
        ageSeconds: c.ageSeconds ?? 5,
        ...(c.resetsAt === undefined ? {} : { sevenDayResetsAt: c.resetsAt }),
      },
      history: c.history ?? [
        { at: dayStart(now) - HOUR, sevenDay },
        { at: now.getTime() - HOUR, sevenDay },
      ],
      runStartAt: c.runStartAt ?? now.getTime() - HOUR,
      ctx: {
        now,
        humanLastTurnAt: now.getTime() - (c.ownerTypedMinAgo ?? 120) * MIN,
      },
      ...(c.dispatched === undefined ? {} : { dispatched: c.dispatched }),
    },
    c.maxReadingAgeSeconds === undefined ? {} : { maxReadingAgeSeconds: c.maxReadingAgeSeconds },
  )
}

describe('seat budget from the charter and seat file', () => {
  it('reads the seat pool stops and the seat spend caps', () => {
    expect(SEAT_B.pool).toMatchObject({
      name: 'pool-y',
      human_uses: false,
      reserve_seven_day: 20,
      night_reserve_seven_day: 8,
      ceiling_five_hour: 80,
      per_day_points: 18,
    })
    expect(SEAT_B.spend).toEqual({ per_run_points: 14, per_day_points: 25 })
  })

  it('names a pool the charter lacks and closes its gate (CC-801)', () => {
    const { charter, seat } = loadPolicy(FIXTURE, 'seat-b')
    const budget = seatBudget(charter, { ...seat, pool: 'pool-missing' })

    expect(budget.pool).toEqual({ name: 'pool-missing', human_uses: true })
    expect(gate({ budget }).reason).toBe(
      'BUDGET-PAUSE pool pool-missing: no reserve_seven_day and ceiling_five_hour for this pool in the charter',
    )
  })

  it('closes on a missing reading and names the pool', () => {
    const result = gatePool({
      ...SEAT_B,
      reading: undefined,
      history: [],
      runStartAt: 0,
      ctx: { now: at(15) },
    })
    expect(result).toEqual({
      open: false,
      pool: 'pool-y',
      reason: 'BUDGET-PAUSE pool pool-y: no seven_day and five_hour reading for this pool',
    })
  })
})

describe('five_hour ceiling', () => {
  it('pauses at the pool ceiling and names the pool and the figure', () => {
    const result = gate({ fiveHour: 80 })
    expect(result.open).toBe(false)
    expect(result.reason).toBe(
      'BUDGET-PAUSE pool pool-y: five_hour 80% at or above ceiling 80% (no seven_day resets_at, flat reserve)',
    )
  })

  it('stays open one point under the ceiling', () => {
    expect(gate({ fiveHour: 79 }).open).toBe(true)
  })

  it('lowers the ceiling to 70 on a human-used pool when the owner typed in the last 15 minutes', () => {
    const result = gate({ budget: SEAT_A, fiveHour: 70, ownerTypedMinAgo: 14 })
    expect(result.reason).toBe(
      'BUDGET-PAUSE pool pool-x: five_hour 70% at or above ceiling 70% (no seven_day resets_at, flat reserve, owner typed in the last 15 min)',
    )
  })

  it('keeps the pool ceiling on a human-used pool once the owner has been quiet 15 minutes', () => {
    expect(gate({ budget: SEAT_A, fiveHour: 74, ownerTypedMinAgo: 15 }).open).toBe(true)
  })

  it('keeps the pool ceiling on a pool the owner does not use, even while the owner types', () => {
    expect(gate({ fiveHour: 75, ownerTypedMinAgo: 1 }).open).toBe(true)
  })
})

describe('seven_day reserve', () => {
  it('pauses at 100 minus the reserve and names the line', () => {
    const result = gate({ budget: SEAT_A, sevenDay: 70 })
    expect(result.reason).toBe(
      'BUDGET-PAUSE pool pool-x: seven_day 70% at or above line 70% (no seven_day resets_at, flat reserve)',
    )
  })

  it('stays open one point under the line', () => {
    expect(gate({ budget: SEAT_A, sevenDay: 69 }).open).toBe(true)
  })

  /** A reset `days` days after `now`, so `now` falls on day 8 - days of the window. */
  const resetIn = (now: Date, days: number) => now.getTime() + days * 24 * HOUR - MIN

  it('holds the full reserve on day 1 of the window (CC-474)', () => {
    const now = at(15)
    expect(gate({ now, sevenDay: 79, resetsAt: resetIn(now, 7) }).open).toBe(true)
    expect(gate({ now, sevenDay: 80, resetsAt: resetIn(now, 7) }).reason).toBe(
      'BUDGET-PAUSE pool pool-y: seven_day 80% at or above line 80% (day 1 of 7)',
    )
  })

  it('lowers the reserve to 2/7 of it on day 6 and 1/7 on day 7: 92.86 and 96.43 for reserve 25', () => {
    const now = at(15)
    const pool25 = { ...SEAT_B, pool: { ...SEAT_B.pool, reserve_seven_day: 25 } as PoolRule }
    expect(gate({ budget: pool25, now, sevenDay: 93, resetsAt: resetIn(now, 2) }).reason).toBe(
      'BUDGET-PAUSE pool pool-y: seven_day 93% at or above line 92.86% (day 6 of 7, seat caps lifted)',
    )
    expect(gate({ budget: pool25, now, sevenDay: 92.85, resetsAt: resetIn(now, 2) }).open).toBe(true)
    expect(gate({ budget: pool25, now, sevenDay: 96.43, resetsAt: resetIn(now, 1) }).reason).toBe(
      'BUDGET-PAUSE pool pool-y: seven_day 96.43% at or above line 96.43% (day 7 of 7, seat caps lifted)',
    )
  })

  it('applies the pool ceiling, not 70, on day 7 while the owner types, but still 70 on day 3', () => {
    const now = at(15)
    const pool85 = { ...SEAT_A, pool: { ...SEAT_A.pool, ceiling_five_hour: 85 } as PoolRule }
    const owner = { budget: pool85, now, fiveHour: 75, ownerTypedMinAgo: 1 }
    expect(gate({ ...owner, resetsAt: resetIn(now, 1) }).open).toBe(true)
    expect(gate({ ...owner, resetsAt: resetIn(now, 5) }).reason).toContain(
      'five_hour 75% at or above ceiling 70%',
    )
  })

  it('ignores the night reserve at night with the owner away', () => {
    expect(gate({ now: at(2), sevenDay: 85, ownerTypedMinAgo: 120 }).reason).toContain('line 80%')
  })

  it('falls back to the flat reserve and says so when the reset is passed', () => {
    const now = at(15)
    expect(gate({ now, sevenDay: 85, resetsAt: now.getTime() - MIN }).reason).toContain(
      'line 80% (no seven_day resets_at, flat reserve)',
    )
  })
})

describe('seat caps on days 6 and 7 (CC-474)', () => {
  const now = at(15)
  const runStartAt = now.getTime() - 2 * HOUR
  const history: SevenDaySample[] = [
    { at: at(6).getTime(), sevenDay: 40 },
    { at: runStartAt, sevenDay: 40 },
  ]

  it('stops on per_run_points on day 5', () => {
    const resetsAt = now.getTime() + 3 * 24 * HOUR - MIN
    expect(gate({ now, runStartAt, history, sevenDay: 54, resetsAt }).reason).toContain('per_run_points 14')
  })

  it('lifts per_run_points and the seat per_day_points on day 6 but keeps the pool per_day_points', () => {
    const resetsAt = now.getTime() + 2 * 24 * HOUR - MIN
    const lifted = gate({ now, runStartAt, history, sevenDay: 57, resetsAt })
    expect(lifted.open).toBe(true)
    expect(lifted.reason).toContain('(day 6 of 7, seat caps lifted)')
    expect(gate({ now, runStartAt, history, sevenDay: 58, resetsAt }).reason).toBe(
      "BUDGET-PAUSE pool pool-y: day spend 18 points since 07:00 at or above the pool pool-y's per_day_points 18",
    )
  })

  it('lifts every seat cap on day 7 when the pool sets no day cap', () => {
    const resetsAt = now.getTime() + 24 * HOUR - MIN
    const budget = { ...SEAT_B, pool: { ...SEAT_B.pool, per_day_points: undefined } as PoolRule }
    expect(gate({ budget, now, runStartAt, history, sevenDay: 75, resetsAt }).open).toBe(true)
  })
})

describe('per_run_points', () => {
  const now = at(15)
  const runStartAt = now.getTime() - 2 * HOUR
  const started = (sevenDay: number): SevenDaySample[] => [
    { at: at(6).getTime(), sevenDay },
    { at: runStartAt, sevenDay },
  ]

  it('pauses when spend since the run-start reading reaches the seat cap', () => {
    const result = gate({ now, runStartAt, history: started(40), sevenDay: 54 })
    expect(result.reason).toBe(
      "BUDGET-PAUSE pool pool-y: run spend 14 points at or above the seat's per_run_points 14",
    )
  })

  it('stays open one point under the seat cap', () => {
    expect(gate({ now, runStartAt, history: started(40), sevenDay: 53 }).open).toBe(true)
  })

  it('adds the points spent before a reset to the points spent after it', () => {
    const history = [...started(60), { at: runStartAt + HOUR, sevenDay: 70 }]
    const result = gate({ now, runStartAt, history, sevenDay: 4 })
    expect(result.reason).toContain('run spend 14 points')
  })

  it('pauses when no reading from the run start exists', () => {
    expect(gate({ now, runStartAt, history: [] }).reason).toBe(
      'BUDGET-PAUSE pool pool-y: no seven_day reading at run start, so run spend is unknown',
    )
  })

  it('pauses when the only reading came after the run start, since it misses earlier spend', () => {
    const history = [{ at: runStartAt + 1000, sevenDay: 52 }]
    expect(gate({ now, runStartAt, history, sevenDay: 53 }).reason).toBe(
      'BUDGET-PAUSE pool pool-y: no seven_day reading at run start, so run spend is unknown',
    )
  })

  it('counts a run as at most 12 hours', () => {
    const budget = { ...SEAT_B, spend: { per_run_points: 14 } }
    const history = [
      { at: now.getTime() - 20 * HOUR, sevenDay: 10 },
      { at: now.getTime() - 13 * HOUR, sevenDay: 30 },
    ]
    const noDayCap = { ...budget, pool: { ...(budget.pool as PoolRule), per_day_points: undefined } }
    const result = gate({
      budget: noDayCap,
      now,
      runStartAt: now.getTime() - 20 * HOUR,
      history,
      sevenDay: 40,
    })
    expect(result.open).toBe(true)
  })
})

describe('per_day_points', () => {
  const now = at(15)
  const runStartAt = at(14).getTime()
  const day = (before7: number, runStart: number): SevenDaySample[] => [
    { at: at(5).getTime(), sevenDay: before7 - 15 },
    { at: at(6, 30).getTime(), sevenDay: before7 },
    { at: runStartAt, sevenDay: runStart },
  ]

  it("pauses at the pool's per_day_points when it is below the seat's", () => {
    const result = gate({ now, runStartAt, history: day(20, 35), sevenDay: 38 })
    expect(result.reason).toBe(
      "BUDGET-PAUSE pool pool-y: day spend 18 points since 07:00 at or above the pool pool-y's per_day_points 18",
    )
  })

  it('stays open one point under the day cap, counting nothing spent before 07:00', () => {
    expect(gate({ now, runStartAt, history: day(20, 35), sevenDay: 37 }).open).toBe(true)
  })

  it('pauses when no reading at or before 07:00 exists, even with no run cap', () => {
    const budget = { ...SEAT_B, spend: {} }
    const history = [{ at: at(7, 1).getTime(), sevenDay: 30 }]
    const result = gate({ budget, now, runStartAt, history, sevenDay: 31 })
    expect(result).toEqual({
      open: false,
      pool: 'pool-y',
      reason: 'BUDGET-PAUSE pool pool-y: no seven_day reading at or before 07:00, so day spend unknown',
    })
  })

  it('pauses on an empty history when the pool has a day cap', () => {
    const budget = { ...SEAT_B, spend: {} }
    expect(gate({ budget, now, runStartAt, history: [] }).reason).toContain('day spend unknown')
  })

  it("pauses at the seat's per_day_points when it is below the pool's", () => {
    const budget = { ...SEAT_A, spend: { per_day_points: 9 } }
    const result = gate({ budget, now, runStartAt, history: day(20, 26), sevenDay: 29 })
    expect(result.reason).toBe(
      "BUDGET-PAUSE pool pool-x: day spend 9 points since 07:00 at or above the seat's per_day_points 9",
    )
  })

  it('names the lower cap when spend has passed both', () => {
    const budget = { ...SEAT_A, spend: { per_day_points: 9 } }
    const result = gate({ budget, now, runStartAt, history: day(20, 30), sevenDay: 33 })
    expect(result.reason).toContain("the seat's per_day_points 9")
  })
})

describe('reading age', () => {
  it('stays open on a reading 15 minutes old', () => {
    expect(gate({ ageSeconds: 900 }).open).toBe(true)
  })

  it('pauses on a reading older than 15 minutes and names its age', () => {
    expect(gate({ ageSeconds: 901 }).reason).toBe(
      'BUDGET-PAUSE pool pool-y: reading is 901s old, over the 900s limit',
    )
  })

  it('closes on a reading with no usable age', () => {
    const noAge = 'BUDGET-PAUSE pool pool-y: reading has no age'
    expect(gate({ ageSeconds: Number.NaN }).reason).toBe(noAge)
    const undatedReading = { fiveHour: 10, sevenDay: 40 } as AccountReading
    const undated = gatePool({
      ...SEAT_B,
      reading: undatedReading,
      history: [],
      runStartAt: 0,
      ctx: { now: at(15) },
    })
    expect(undated.reason).toBe(noAge)
  })

  it('honours a caller limit and skips the check only for an infinite one', () => {
    expect(gate({ ageSeconds: 61, maxReadingAgeSeconds: 60 }).reason).toBe(
      'BUDGET-PAUSE pool pool-y: reading is 61s old, over the 60s limit',
    )
    expect(gate({ ageSeconds: 86_400, maxReadingAgeSeconds: Number.POSITIVE_INFINITY }).open).toBe(true)
    expect(gate({ ageSeconds: Number.NaN, maxReadingAgeSeconds: Number.POSITIVE_INFINITY }).open).toBe(true)
  })
})

describe('sonnet-only band', () => {
  it('opens sonnet only within 10 points of the five_hour ceiling', () => {
    expect(gate({ fiveHour: 70 })).toMatchObject({ open: true, sonnetOnly: true })
    expect(gate({ fiveHour: 69 })).toMatchObject({ open: true, sonnetOnly: false })
  })

  it('opens sonnet only within 10 points of the seven_day line', () => {
    const band = gate({ sevenDay: 70 })
    expect(band).toMatchObject({ open: true, sonnetOnly: true })
    expect(band.reason).toContain('within 10 points, sonnet only')
    expect(gate({ sevenDay: 69 })).toMatchObject({ open: true, sonnetOnly: false })
  })
})

describe('points spent', () => {
  it('counts a sample past the window reset from zero even when the reading rose', () => {
    const samples = [
      { at: 0, sevenDay: 30, resetsAt: 10 },
      { at: 20, sevenDay: 35 },
    ]
    expect(pointsSpent(samples)).toBe(35)
  })

  it('counts a drop as a reset', () => {
    expect(
      pointsSpent([
        { at: 0, sevenDay: 50 },
        { at: 1, sevenDay: 58 },
        { at: 2, sevenDay: 3 },
      ]),
    ).toBe(11)
  })
})

describe('spend day', () => {
  it('starts at 07:00 local today once 07:00 has passed', () => {
    expect(dayStart(at(7))).toBe(at(7).getTime())
  })

  it('starts at 07:00 local yesterday before 07:00', () => {
    expect(dayStart(at(6, 59))).toBe(new Date(2026, 8, 28, 7).getTime())
  })
})

describe('run start', () => {
  const now = at(20)

  it('is the later of the owner message and the recorded start', () => {
    const ownerMessageAt = at(15).getTime()
    const recordedAt = at(16).getTime()
    expect(runStartAt(now, { ownerMessageAt, recordedAt })).toBe(recordedAt)
    expect(runStartAt(now, { ownerMessageAt: at(17).getTime(), recordedAt })).toBe(at(17).getTime())
  })

  it('is never more than 12 hours ago, and is 12 hours ago with nothing recorded', () => {
    expect(runStartAt(now, { recordedAt: now.getTime() - 20 * HOUR })).toBe(now.getTime() - RUN_CAP_MS)
    expect(runStartAt(now)).toBe(now.getTime() - RUN_CAP_MS)
  })

  it('treats a non-finite start as absent', () => {
    const recordedAt = at(16).getTime()
    expect(runStartAt(now, { ownerMessageAt: Number.NaN, recordedAt: Number.NaN })).toBe(
      now.getTime() - RUN_CAP_MS,
    )
    expect(runStartAt(now, { ownerMessageAt: Number.NaN, recordedAt })).toBe(recordedAt)
  })
})

describe("this tick's dispatches charged against the pool (CC-275)", () => {
  const now = at(15)
  const priced = (cost: { dispatch_seven_day_points?: number; dispatch_five_hour_points?: number }) => ({
    ...SEAT_B,
    spend: {},
    pool: { ...(SEAT_B.pool as PoolRule), ...cost },
  })
  const history = [{ at: at(6, 30).getTime(), sevenDay: 30 }]

  it('closes at per_day_points once the charged dispatches reach it', () => {
    const budget = priced({ dispatch_seven_day_points: 5 })

    expect(gate({ budget, now, history, sevenDay: 35, dispatched: 2 }).open).toBe(true)
    expect(gate({ budget, now, history, sevenDay: 35, dispatched: 3 }).reason).toBe(
      "BUDGET-PAUSE pool pool-y: day spend 20 points since 07:00 at or above the pool pool-y's per_day_points 18; charged 3 dispatch(es) this tick at +15 seven_day, +30 five_hour",
    )
  })

  it('closes at the five_hour ceiling and the seven_day line once charged', () => {
    const budget = priced({ dispatch_seven_day_points: 1, dispatch_five_hour_points: 35 })

    expect(gate({ budget, now, history, sevenDay: 31, dispatched: 1 }).open).toBe(true)
    expect(gate({ budget, now, history, sevenDay: 31, dispatched: 2 }).reason).toContain(
      'five_hour 80% at or above ceiling 80%',
    )
    const line = priced({ dispatch_seven_day_points: 40, dispatch_five_hour_points: 0 })
    expect(
      gate({
        budget: { ...line, pool: { ...line.pool, per_day_points: undefined } },
        now,
        history,
        sevenDay: 41,
        dispatched: 1,
      }).reason,
    ).toContain('seven_day 81% at or above line 80%')
  })

  it('charges the default cost when the pool prices no dispatch', () => {
    const result = gate({ budget: priced({}), now, history, sevenDay: 31, dispatched: 1 })

    expect(result.reason).toContain(
      `seven_day ${31 + DEFAULT_DISPATCH_COST.sevenDay}% vs line 80% (no seven_day resets_at, flat reserve); charged 1 dispatch(es) this tick at +${DEFAULT_DISPATCH_COST.sevenDay} seven_day, +${DEFAULT_DISPATCH_COST.fiveHour} five_hour`,
    )
  })
})
