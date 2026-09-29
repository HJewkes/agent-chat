import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  dayStart,
  gatePool,
  pointsSpent,
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

/** seat-b on pool-y: no human use, line 80 (92 at night), ceiling 80, 18 a day; seat caps 14 a run, 25 a day. */
const SEAT_B = budgetOf('seat-b')
/** seat-a on pool-x: human use, line 70, ceiling 75, 12 a day; seat caps 5 a run, 9 a day. */
const SEAT_A = budgetOf('seat-a')

interface Case {
  budget?: { pool?: PoolRule; spend: PoolGateInput['spend'] }
  now?: Date
  fiveHour?: number
  sevenDay?: number
  history?: SevenDaySample[]
  runStartAt?: number
  ownerTypedMinAgo?: number
}

function gate(c: Case) {
  const now = c.now ?? at(15)
  const sevenDay = c.sevenDay ?? 40
  const budget = c.budget ?? SEAT_B
  return gatePool({
    pool: budget.pool,
    spend: budget.spend,
    reading: { fiveHour: c.fiveHour ?? 10, sevenDay, ageSeconds: 5 },
    history: c.history ?? [{ at: now.getTime() - HOUR, sevenDay }],
    runStartAt: c.runStartAt ?? now.getTime() - HOUR,
    ctx: {
      now,
      humanLastTurnAt: now.getTime() - (c.ownerTypedMinAgo ?? 120) * MIN,
    },
  })
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

  it('leaves the pool unset for a seat whose pool the charter lacks, which closes the gate', () => {
    const { charter, seat } = loadPolicy(FIXTURE, 'seat-b')
    const budget = seatBudget(charter, { ...seat, pool: 'pool-missing' })

    expect(budget.pool).toBeUndefined()
    expect(gate({ budget }).reason).toBe(
      'BUDGET-PAUSE pool unknown: no reserve_seven_day and ceiling_five_hour for this pool in the charter',
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
    expect(result.reason).toBe('BUDGET-PAUSE pool pool-y: five_hour 80% at or above ceiling 80%')
  })

  it('stays open one point under the ceiling', () => {
    expect(gate({ fiveHour: 79 }).open).toBe(true)
  })

  it('lowers the ceiling to 70 on a human-used pool when the owner typed in the last 15 minutes', () => {
    const result = gate({ budget: SEAT_A, fiveHour: 70, ownerTypedMinAgo: 14 })
    expect(result.reason).toBe(
      'BUDGET-PAUSE pool pool-x: five_hour 70% at or above ceiling 70% (owner typed in the last 15 min)',
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
    expect(result.reason).toBe('BUDGET-PAUSE pool pool-x: seven_day 70% at or above line 70%')
  })

  it('stays open one point under the line', () => {
    expect(gate({ budget: SEAT_A, sevenDay: 69 }).open).toBe(true)
  })

  it('uses the night reserve between 23:00 and 07:00 when the owner has been silent 30 minutes', () => {
    expect(gate({ now: at(2), sevenDay: 91, ownerTypedMinAgo: 30 }).open).toBe(true)
    expect(gate({ now: at(2), sevenDay: 92, ownerTypedMinAgo: 30 }).reason).toBe(
      'BUDGET-PAUSE pool pool-y: seven_day 92% at or above line 92% (night reserve)',
    )
  })

  it('keeps the day reserve at night while the owner is active', () => {
    expect(gate({ now: at(2), sevenDay: 85, ownerTypedMinAgo: 29 }).reason).toContain('line 80%')
  })

  it('keeps the day reserve outside the night hours', () => {
    expect(gate({ now: at(7), sevenDay: 85, ownerTypedMinAgo: 120 }).reason).toContain('line 80%')
  })
})

describe('per_run_points', () => {
  const now = at(15)
  const runStartAt = now.getTime() - 2 * HOUR
  const started = (sevenDay: number): SevenDaySample[] => [{ at: runStartAt, sevenDay }]

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
