import { describe, expect, it } from 'vitest'
import { RUN_CAP_MS, dayStart } from '../agents/burndown/budget-gate.js'
import {
  RESTART_WINDOW_MAX_MS,
  advanceMeter,
  dayAllowance,
  meterHistory,
  readSeatLog,
  restartWindow,
  sameSpendDay,
  withinRun,
  type SpendMeter,
} from '../agents/seats/stops.js'
import { poolBudget } from '../agents/seats/watchdog.js'

const at = (hour: number, minute = 0, date = 29): number => new Date(2026, 8, date, hour, minute).getTime()

describe('spend meters', () => {
  it('starts at zero on the first reading', () => {
    expect(advanceMeter(undefined, 19, at(8), sameSpendDay)).toEqual({ since: at(8), last: 19, spent: 0 })
  })

  it('adds each rise in seven_day', () => {
    const meter = advanceMeter({ since: at(8), last: 19, spent: 2 }, 23, at(9), sameSpendDay)
    expect(meter).toEqual({ since: at(8), last: 23, spent: 6 })
  })

  it('counts nothing across a window reset and carries on from the new reading', () => {
    const meter = advanceMeter({ since: at(8), last: 60, spent: 5 }, 1, at(9), sameSpendDay)
    expect(meter).toEqual({ since: at(8), last: 1, spent: 5 })
  })

  it('keeps the meter unchanged without a reading', () => {
    const meter: SpendMeter = { since: at(8), last: 19, spent: 2 }
    expect(advanceMeter(meter, undefined, at(9), sameSpendDay)).toBe(meter)
  })

  it('starts a new day at 07:00 local', () => {
    expect(sameSpendDay({ since: at(6, 59), last: 0, spent: 0 }, at(7))).toBe(false)
    expect(sameSpendDay({ since: at(7), last: 0, spent: 0 }, at(6, 59, 30))).toBe(true)
    const meter = advanceMeter({ since: at(6), last: 19, spent: 9 }, 25, at(7, 8), sameSpendDay)
    expect(meter).toEqual({ since: at(7, 8), last: 25, spent: 0, before: 19 })
  })

  it('starts a new run after the 12-hour cap', () => {
    const meter: SpendMeter = { since: at(8), last: 19, spent: 6 }
    expect(withinRun(meter, at(8) + RUN_CAP_MS - 1)).toBe(true)
    expect(withinRun(meter, at(8) + RUN_CAP_MS)).toBe(false)
  })
})

describe('meterHistory', () => {
  const meter = (since: number, last: number, spent: number): SpendMeter => ({ since, last, spent })

  it("reads each meter as the pool's reading at its window's start", () => {
    const history = meterHistory(
      [
        { at: at(8), meter: meter(at(8), 30, 6) },
        { at: at(7), meter: meter(at(7, 8), 30, 10) },
      ],
      at(9),
    )
    expect(history).toEqual([
      { at: at(7), sevenDay: 20 },
      { at: at(8), sevenDay: 24 },
    ])
  })

  it("dates a meter started this pass just before now, so it still counts as the window's opening reading", () => {
    expect(meterHistory([{ at: at(9), meter: meter(at(9), 30, 0) }], at(9))).toEqual([
      { at: at(9) - 1, sevenDay: 30 },
    ])
  })

  it('lowers an earlier start that disagrees with a later one, so the chain never reads as a reset', () => {
    const history = meterHistory(
      [
        { at: at(5), meter: meter(at(5), 30, 4) },
        { at: at(7), meter: meter(at(7, 8), 30, 12) },
      ],
      at(9),
    )
    expect(history).toEqual([
      { at: at(5), sevenDay: 18 },
      { at: at(7), sevenDay: 18 },
    ])
  })

  it('skips a window with no meter', () => {
    expect(meterHistory([{ at: at(7), meter: undefined }], at(9))).toEqual([])
  })

  it("dates the prior day's last reading at 07:00 when the day meter's first sample comes later", () => {
    const history = meterHistory([{ at: at(7), meter: { ...meter(at(9), 30, 0), before: 20 } }], at(10))
    expect(history).toEqual([
      { at: at(7), sevenDay: 20 },
      { at: at(9), sevenDay: 30 },
    ])
  })

  describe('the day gate when the first sample is after 07:00', () => {
    const pool = {
      name: 'agents',
      configDir: '/pool',
      humanUses: false,
      rule: { reserve_seven_day: 25, ceiling_five_hour: 70 },
      perDayPoints: 13,
    }
    const now = new Date(2026, 8, 29, 10)
    const gate = (day: SpendMeter) =>
      poolBudget({
        pool,
        spend: {},
        reading: { ageSeconds: 0, fiveHour: 5, sevenDay: 35 },
        history: meterHistory([{ at: dayStart(now), meter: day }], now.getTime()),
        runStartAt: at(9),
        now,
      })

    it('closes on spend since the 07:00 reading, not since the first sample', () => {
      const verdict = gate({ since: at(9), last: 35, spent: 5, before: 20 })
      expect(verdict.open).toBe(false)
      expect(verdict.reason).toContain('day spend 15 points')
    })

    it('stays closed on every later pass of the day, not only the pass that starts the meter', () => {
      const opened = advanceMeter({ since: at(6), last: 20, spent: 0 }, 30, at(9), sameSpendDay)
      const passes = [at(9, 5), at(9, 10), at(9, 15)]
      const meters = passes.reduce<SpendMeter[]>(
        (chain, nowMs) => [...chain, advanceMeter(chain.at(-1), 35, nowMs, sameSpendDay) as SpendMeter],
        [opened as SpendMeter],
      )
      const verdicts = meters.slice(1).map(day => gate(day))
      expect(verdicts.map(v => v.open)).toEqual([false, false, false])
      expect(meters.every(m => m.before === 20)).toBe(true)
    })

    it('counts from the first sample when no earlier reading exists', () => {
      expect(gate({ since: at(9), last: 35, spent: 5 }).open).toBe(true)
    })
  })
})

describe('readSeatLog', () => {
  const day = new Date(2026, 8, 29)

  it.each([['BUDGET-PAUSE five_hour 71%, seven_day 30%'], ['PARKED by the owner until Monday']])(
    'reads a latest line "%s" as a stop',
    line => {
      const verdict = readSeatLog(`06:02 dispatched hs-1\n06:30 ${line}\n`, day)
      expect(verdict.stop).toMatch(/^seat logged "(BUDGET-PAUSE|PARKED)/)
      expect(verdict.activityAt).toBe(at(6, 30))
    },
  )

  it('ignores a pause the seat has since logged past', () => {
    expect(
      readSeatLog('06:30 BUDGET-PAUSE five_hour 71%\n07:40 window reset; dispatched hs-2\n', day).stop,
    ).toBeUndefined()
  })

  it("does not count the watchdog's own lines as the seat's activity", () => {
    const verdict = readSeatLog('06:30 PARKED\n07:08 Watchdog: 0 implementers; woke seat (m)\n', day)
    expect(verdict).toEqual({ stop: 'seat logged "PARKED"', activityAt: at(6, 30) })
  })

  it('reads an empty log as nothing', () => {
    expect(readSeatLog('', day)).toEqual({})
  })
})

describe('restartWindow', () => {
  const now = Date.parse('2026-09-29T12:00:00Z')
  const msg = (minutesAgo: number, body: string) => ({ ts: now - minutesAgo * 60_000, body })

  it('is open after an announcement with no "restart done"', () => {
    expect(restartWindow([msg(10, 'seat-a: restart at 06:00, hold dispatch')], now)).toBe(
      'restart window open since 11:50Z',
    )
    expect(restartWindow([msg(1, 'broker restart NOW, on the owner word')], now)).toMatch(/open/)
  })

  it('closes on "restart done"', () => {
    const messages = [msg(10, 'restart at 06:00'), msg(2, 'seat-a: restart done (pid 1)')]
    expect(restartWindow(messages, now)).toBeUndefined()
  })

  it('reopens on a later announcement', () => {
    const messages = [msg(60, 'restart at 05:00'), msg(50, 'restart done'), msg(5, 'restart at 06:00')]
    expect(restartWindow(messages, now)).toMatch(/open/)
  })

  it('lapses after the window cap so a lost "restart done" cannot hold every seat', () => {
    const stale = { ts: now - RESTART_WINDOW_MAX_MS - 1, body: 'restart at 06:00' }
    expect(restartWindow([stale], now)).toBeUndefined()
  })

  it('is closed with no messages', () => {
    expect(restartWindow([], now)).toBeUndefined()
  })
})

describe('the reset-aware day allowance (CC-404)', () => {
  const DAY = 24 * 3_600_000
  const base = {
    pacing: 'reset-aware',
    reserveSevenDay: 25,
    perDayPoints: [12],
    sevenDay: 55,
    daySpend: 10,
    nowMs: at(10),
  }

  it.each([
    [0.5, 60],
    [3, 10],
    [6, 5],
  ])('spreads the 30 points left under line 75 at the day start over %s days as %s a day', (days, points) => {
    const allowance = dayAllowance({ ...base, resetsAt: at(10) + days * DAY })
    expect(allowance).toMatchObject({
      source: 'reset-aware',
      points,
      stopLine: 75,
      dayStartSevenDay: 45,
      basis: 'day-start',
      daysToReset: days,
    })
  })

  it("counts from the day start, so the day's own spend does not shrink its allowance", () => {
    const allowance = dayAllowance({ ...base, sevenDay: 60, daySpend: 10, resetsAt: at(10) + 0.5 * DAY })
    expect(allowance).toMatchObject({ points: 50, sevenDay: 60, dayStartSevenDay: 50, basis: 'day-start' })
  })

  it('spreads from the current seven_day when the day spend is unknown', () => {
    const allowance = dayAllowance({ ...base, daySpend: undefined, resetsAt: at(10) + 2 * DAY })
    expect(allowance).toMatchObject({ points: 10, dayStartSevenDay: 55, basis: 'current' })
  })

  it('falls back to the smallest per_day_points with no resets_at', () => {
    const allowance = dayAllowance({ ...base, perDayPoints: [12, undefined, 9], resetsAt: undefined })
    expect(allowance).toMatchObject({ source: 'per_day_points', points: 9, daysToReset: null })
  })

  it('falls back for any pacing value other than reset-aware', () => {
    const allowance = dayAllowance({ ...base, pacing: 'even', resetsAt: at(10) + 3 * DAY })
    expect(allowance).toMatchObject({ source: 'per_day_points', points: 12 })
  })

  it('allows nothing once seven_day at the day start is past the line', () => {
    const allowance = dayAllowance({ ...base, sevenDay: 90, resetsAt: at(10) + DAY })
    expect(allowance).toMatchObject({ source: 'reset-aware', points: 0 })
  })
})
