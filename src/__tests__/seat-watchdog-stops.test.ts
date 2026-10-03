import { describe, expect, it } from 'vitest'
import { RUN_CAP_MS, dayStart } from '../agents/burndown/budget-gate.js'
import {
  RESTART_WINDOW_MAX_MS,
  advanceMeter,
  dayAllowance,
  machineStop,
  meterHistory,
  pacedCaps,
  readSeatLog,
  restartWindow,
  sameSpendDay,
  withinRun,
  type MachineStopLimits,
  type MachineStopReadings,
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

  it("does not count the watchdog's relaunch line as the seat's activity", () => {
    const log = '06:30 heartbeat\n07:08 watchdog relaunch seat-a (no log line for 38 min; resumed)\n'
    expect(readSeatLog(log, day)).toEqual({ activityAt: at(6, 30) })
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
    dayStartMs: at(7),
    nowMs: at(7),
  }

  // CC-474: the line is 100 - 25 * (8 - d) / 7 on day d of the window at 07:00.
  it.each([
    [0.5, 96.43, 102.86],
    [3, 89.29, 14.76],
    [6, 78.57, 5.59],
  ])(
    'spreads the points left at 07:00 under the declining line over %s days to reset: line %s, %s a day',
    (days, stopLine, points) => {
      const allowance = dayAllowance({ ...base, resetsAt: at(7) + days * DAY })
      expect(allowance).toMatchObject({
        source: 'reset-aware',
        points,
        stopLine,
        dayStartSevenDay: 45,
        basis: 'day-start',
        daysToReset: days,
      })
    },
  )

  it("counts from the day start, so the day's own spend does not shrink its allowance", () => {
    const allowance = dayAllowance({ ...base, sevenDay: 60, daySpend: 10, resetsAt: at(7) + 0.5 * DAY })
    expect(allowance).toMatchObject({ points: 92.86, sevenDay: 60, dayStartSevenDay: 50, basis: 'day-start' })
  })

  it('holds the same allowance at 23:00 as at 07:00, measuring days from the day start', () => {
    const resetsAt = at(7) + 3 * DAY
    const morning = dayAllowance({ ...base, resetsAt })
    const night = dayAllowance({ ...base, nowMs: at(23), resetsAt })
    expect(night).toEqual(morning)
  })

  it('spreads from the current seven_day over the days from now when the day spend is unknown', () => {
    const allowance = dayAllowance({
      ...base,
      daySpend: undefined,
      nowMs: at(19),
      resetsAt: at(19) + 2 * DAY,
    })
    expect(allowance).toMatchObject({ points: 18.93, dayStartSevenDay: 55, basis: 'current', daysToReset: 2 })
  })

  it('falls back to the smallest per_day_points with no resets_at', () => {
    const allowance = dayAllowance({ ...base, perDayPoints: [12, undefined, 9], resetsAt: undefined })
    expect(allowance).toMatchObject({ source: 'per_day_points', points: 9, daysToReset: null })
  })

  it('falls back to per_day_points once the reset is at or before now', () => {
    const allowance = dayAllowance({ ...base, nowMs: at(9), resetsAt: at(9) })
    expect(allowance).toMatchObject({ source: 'per_day_points', points: 12 })
  })

  it('falls back for any pacing value other than reset-aware', () => {
    const allowance = dayAllowance({ ...base, pacing: 'even', resetsAt: at(7) + 3 * DAY })
    expect(allowance).toMatchObject({ source: 'per_day_points', points: 12 })
  })

  it('allows nothing once seven_day at the day start is past the line', () => {
    const allowance = dayAllowance({ ...base, sevenDay: 99, daySpend: 2, resetsAt: at(7) + DAY })
    expect(allowance).toMatchObject({ source: 'reset-aware', points: 0 })
  })
})

describe('the paced caps every gate hands gatePool (CC-404)', () => {
  const DAY = 24 * 3_600_000
  const now = new Date(2026, 8, 29, 10)
  const input = {
    pacing: 'reset-aware',
    pool: {
      name: 'agents',
      human_uses: false,
      reserve_seven_day: 30,
      ceiling_five_hour: 70,
      per_day_points: 12,
    },
    spend: { per_run_points: 6, per_day_points: 9 },
    sevenDay: 46,
    resetsAt: at(7) + 3 * DAY,
    history: [{ at: at(6), sevenDay: 40 }],
    now,
  }

  it('replaces both day caps with the allowance and names it, leaving the run cap', () => {
    const paced = pacedCaps(input)
    expect(paced.allowance).toMatchObject({ points: 15.71, dayStartSevenDay: 40, basis: 'day-start' })
    expect(paced.pool?.per_day_points).toBeUndefined()
    expect(paced.spend).toEqual({
      per_run_points: 6,
      per_day_points: 15.71,
      per_day_label: "seat's reset-aware day allowance",
    })
  })

  it('leaves the pool day cap on the pool on day 6, when gatePool lifts the seat caps (CC-474)', () => {
    const paced = pacedCaps({ ...input, resetsAt: now.getTime() + 2 * DAY - 60_000 })
    expect(paced.pool).toBe(input.pool)
    expect(paced.spend).toBe(input.spend)
  })

  it('returns the caps unchanged for a seat without the key', () => {
    const paced = pacedCaps({ ...input, pacing: undefined })
    expect(paced.pool).toBe(input.pool)
    expect(paced.spend).toBe(input.spend)
  })

  it("holds the watchdog gate at the pool's per_day_points on day 7, half a day from the reset (CC-474)", () => {
    const verdict = poolBudget({
      pool: {
        name: 'agents',
        configDir: '/pool',
        humanUses: false,
        rule: { reserve_seven_day: 30, ceiling_five_hour: 70 },
        perDayPoints: 12,
      },
      spend: { perDayPoints: 9 },
      reading: { ageSeconds: 0, fiveHour: 5, sevenDay: 52, sevenDayResetsAt: at(7) + 0.5 * DAY },
      history: input.history,
      runStartAt: at(9),
      now,
      pacing: 'reset-aware',
      resetsAt: at(7) + 0.5 * DAY,
    })
    expect(verdict.open).toBe(false)
    expect(verdict.reason).toContain("at or above the pool agents's per_day_points 12")
  })
})

describe('machineStop swap and pressure level (CC-492)', () => {
  const limits: MachineStopLimits = {
    memoryFreePercent: 20,
    load5: 28,
    swapUsedPercent: 60,
    pressureLevel: 2,
  }
  const calm: MachineStopReadings = { memoryFreePercent: 60, load5: 2, swapUsedPercent: 10, pressureLevel: 1 }

  it('swap at 60.1 percent with memory and load fine stops the seat and names swap', () => {
    const stop = machineStop({ ...calm, swapUsedPercent: 60.1 }, limits)

    expect(stop?.reason).toBe('machine under pressure: swap 60.1% used (limit 60%)')
  })

  it('swap at exactly 60 percent does not stop', () => {
    expect(machineStop({ ...calm, swapUsedPercent: 60 }, limits)).toBeNull()
  })

  it('pressure level 2 stops and level 1 does not', () => {
    expect(machineStop({ ...calm, pressureLevel: 2 }, limits)?.reason).toBe(
      'machine under pressure: pressure level 2 (limit 2)',
    )
    expect(machineStop({ ...calm, pressureLevel: 1 }, limits)).toBeNull()
  })

  it('null swap and null pressure readings never stop', () => {
    expect(machineStop({ ...calm, swapUsedPercent: null, pressureLevel: null }, limits)).toBeNull()
  })

  it('swap limit set to null in config disables the swap trigger', () => {
    expect(machineStop({ ...calm, swapUsedPercent: 95 }, { ...limits, swapUsedPercent: null })).toBeNull()
  })
})
