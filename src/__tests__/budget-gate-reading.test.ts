import { describe, expect, it } from 'vitest'
import {
  gatePool,
  type PoolGateInput,
  type PoolRule,
  type SpendCaps,
} from '../agents/burndown/budget-gate.js'
import { bindingOf } from '../agents/burndown/gate-reading.js'

/** CC-1097: a closed pool gate names the lever that closed it, with the cap, the reading and the room left. */

const MIN = 60_000
const HOUR = 60 * MIN
const NOW = new Date(2026, 9, 11, 17, 43)
const NOW_MS = NOW.getTime()
const RUN_START = NOW_MS - 3 * HOUR

const WORKOUT: PoolRule = { name: 'workout', human_uses: false, reserve_seven_day: 10, ceiling_five_hour: 95 }

interface Case {
  pool?: PoolRule
  spend?: SpendCaps
  sevenDay?: number
  fiveHour?: number
  ageSeconds?: number
  history?: PoolGateInput['history']
  dispatched?: number
}

function gate(c: Case) {
  const sevenDay = c.sevenDay ?? 30
  return gatePool({
    pool: c.pool ?? WORKOUT,
    spend: c.spend ?? {},
    reading: { sevenDay, fiveHour: c.fiveHour ?? 20, ageSeconds: c.ageSeconds ?? 5 },
    history: c.history ?? [{ at: RUN_START - HOUR, sevenDay }],
    runStartAt: RUN_START,
    ctx: { now: NOW },
    ...(c.dispatched === undefined ? {} : { dispatched: c.dispatched }),
  })
}

/** Run spend 107 across a window reset: 12 to 100 is 88, then 19 in the new window. */
const RUN_107 = [
  { at: RUN_START - MIN, sevenDay: 12 },
  { at: RUN_START + HOUR, sevenDay: 100, resetsAt: RUN_START + 2 * HOUR },
]

describe('closed pool gate readings', () => {
  it('names the seat per_run cap with its value, the run spend and a negative headroom', () => {
    const result = gate({ spend: { per_run_points: 60 }, sevenDay: 19, history: RUN_107 })

    expect(result).toEqual({
      open: false,
      pool: 'workout',
      reason: "BUDGET-PAUSE pool workout: run spend 107 points at or above the seat's per_run_points 60",
      gate: {
        lever: 'spend.per_run_points',
        value: 60,
        reading: 107,
        headroom: -47,
        source: 'seats/<seat>.md',
      },
    })
  })

  it('takes the source from the seat caps when the caller sets one', () => {
    const result = gate({
      spend: { per_run_points: 60, source: 'seats/titan-coord.md' },
      sevenDay: 19,
      history: RUN_107,
    })

    expect(!result.open && result.gate.source).toBe('seats/titan-coord.md')
  })

  it('names the lower of the pool and seat day caps when both are hit', () => {
    const history = [{ at: new Date(2026, 9, 11, 6).getTime(), sevenDay: 10 }]
    const pool = { ...WORKOUT, per_day_points: 45 }

    const result = gate({ pool, spend: { per_day_points: 48 }, sevenDay: 60, history })

    expect(result.reason).toBe(
      "BUDGET-PAUSE pool workout: day spend 50 points since 07:00 at or above the pool workout's per_day_points 45",
    )
    expect(!result.open && result.gate).toEqual({
      lever: 'pools.workout.per_day_points',
      value: 45,
      reading: 50,
      headroom: -5,
      source: 'autonomy charter pools',
    })
  })

  it('names the seat day cap when it is the lower one', () => {
    const history = [{ at: new Date(2026, 9, 11, 6).getTime(), sevenDay: 10 }]
    const pool = { ...WORKOUT, per_day_points: 48 }

    const result = gate({ pool, spend: { per_day_points: 45 }, sevenDay: 60, history })

    expect(!result.open && result.gate).toMatchObject({
      lever: 'spend.per_day_points',
      value: 45,
      reading: 50,
    })
  })

  it('reads the five_hour ceiling against the charged reading', () => {
    const result = gate({ fiveHour: 46, dispatched: 5 })

    expect(!result.open && result.gate).toEqual({
      lever: 'pools.workout.ceiling_five_hour',
      value: 95,
      reading: 96,
      headroom: -1,
      source: 'autonomy charter pools',
    })
  })

  it('reads the seven_day reserve as its line', () => {
    const result = gate({ sevenDay: 92 })

    expect(!result.open && result.gate).toEqual({
      lever: 'pools.workout.reserve_seven_day',
      value: 90,
      reading: 92,
      headroom: -2,
      source: 'autonomy charter pools',
    })
  })

  it('gives a stale reading a binary gate with no figures', () => {
    const result = gate({ ageSeconds: 100_000 })

    expect(!result.open && result.gate).toEqual({
      lever: 'pools.workout.reading',
      value: null,
      reading: null,
      headroom: null,
      source: 'account status reading',
    })
  })

  it('gives unknown run spend a binary spend.reading gate', () => {
    const result = gate({ spend: { per_run_points: 60 }, history: [] })

    expect(!result.open && result.gate).toMatchObject({ lever: 'spend.reading', value: null })
  })

  it('leaves an open gate without a reading', () => {
    expect(gate({})).not.toHaveProperty('gate')
  })
})

describe('bindingOf', () => {
  const capped = { lever: 'spend.per_run_points', value: 60, reading: 107, headroom: -47, source: 's' }

  it('names the first capacity refusal, passing over earlier eligibility ones', () => {
    const refusals = [
      { initiative: 'i', task: 'T-1', kind: 'claimed', gate: { ...capped, lever: 'gate.claimed' } },
      { initiative: 'i', task: 'T-2', kind: 'budget', gate: capped },
      {
        initiative: 'i',
        task: 'T-3',
        kind: 'role-cap',
        gate: { ...capped, lever: 'concurrency.implementers' },
      },
    ]

    expect(bindingOf(refusals)).toEqual({ kind: 'budget', initiative: 'i', task: 'T-2', ...capped })
  })

  it('is null when no capacity lever refused', () => {
    expect(bindingOf([{ initiative: 'i', kind: 'file-overlap' }])).toBeNull()
  })
})
