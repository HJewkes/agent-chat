import { describe, expect, it } from 'vitest'
import {
  RESTART_WINDOW_MAX_MS,
  RUN_CAP_MS,
  advanceMeter,
  readSeatLog,
  restartWindow,
  sameSpendDay,
  spendDay,
  spendStop,
  withinRun,
  type SpendMeter,
} from '../agents/seats/stops.js'

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
    expect(spendDay(at(6, 59))).not.toBe(spendDay(at(7)))
    expect(spendDay(at(7))).toBe(spendDay(at(6, 59, 30)))
    const meter = advanceMeter({ since: at(6), last: 19, spent: 9 }, 25, at(7, 8), sameSpendDay)
    expect(meter).toEqual({ since: at(7, 8), last: 25, spent: 0 })
  })

  it('starts a new run after the 12-hour cap', () => {
    const meter: SpendMeter = { since: at(8), last: 19, spent: 6 }
    expect(withinRun(meter, at(8) + RUN_CAP_MS - 1)).toBe(true)
    expect(withinRun(meter, at(8) + RUN_CAP_MS)).toBe(false)
  })
})

describe('spendStop', () => {
  const seat = { spend: { perRunPoints: 6, perDayPoints: 10 } }
  const pool = { name: 'claude', perDayPoints: 13 }
  const meter = (spent: number): SpendMeter => ({ since: at(7), last: 30, spent })

  it('holds at the lower of the seat and pool day caps', () => {
    expect(spendStop(seat, pool, meter(10), meter(0))).toMatch(
      /^per_day_points stop: pool claude spent 10 of 10 since 07:00/,
    )
    expect(spendStop({ spend: { perDayPoints: 20 } }, pool, meter(13), undefined)).toMatch(/13 of 13/)
  })

  it('holds at the seat run cap', () => {
    expect(spendStop(seat, pool, meter(3), meter(6))).toMatch(/^per_run_points stop: 6 of 6/)
  })

  it('is open below both caps, and without caps or meters', () => {
    expect(spendStop(seat, pool, meter(9), meter(5))).toBeUndefined()
    expect(spendStop({ spend: {} }, { name: 'p' }, meter(99), meter(99))).toBeUndefined()
    expect(spendStop(seat, pool, undefined, undefined)).toBeUndefined()
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
    expect(restartWindow([msg(10, 'hjewkes-surplus: restart at 06:00, hold dispatch')], now)).toBe(
      'restart window open since 11:50Z',
    )
    expect(restartWindow([msg(1, 'broker restart NOW, on the owner word')], now)).toMatch(/open/)
  })

  it('closes on "restart done"', () => {
    const messages = [msg(10, 'restart at 06:00'), msg(2, 'hjewkes-surplus: restart done (pid 1)')]
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
