import { describe, expect, it } from 'vitest'
import { heartbeatGaps, pauseHolds, type DeliveryRow } from '../agents/seats/heartbeat-gaps.js'

const at = (hh: number, mm: number, day = 10): number => new Date(2026, 9, day, hh, mm).getTime()
const MIN = 60_000
const CRON = '17,47 * * * *'

const watchdog = (hh: number, mm: number, slot?: number): DeliveryRow => ({
  event: 'heartbeat_watchdog',
  at: at(hh, mm),
  ...(slot === undefined ? {} : { slot }),
})

describe('heartbeatGaps', () => {
  // Catches: comparing against a fixed limit instead of the cron's own quiet limit (35 min for 17,47).
  it('reports a 60 min hole as one gap over the 35 min limit of a two-slot cron', () => {
    const rows = [watchdog(17, 53), watchdog(18, 23), watchdog(19, 23)]

    const report = heartbeatGaps({ cron: CRON, rows, holds: [], fromMs: at(17, 53), toMs: at(19, 23) })

    expect(report.limitMinutes).toBe(35)
    expect(report.gaps).toEqual([{ fromMs: at(18, 23), toMs: at(19, 23), minutes: 60 }])
  })

  // Catches: counting delivery rows instead of slots, or ignoring an external row's slot.
  it('reports a watchdog and an external delivery for one slot as a double', () => {
    const slot = at(18, 17)
    const rows: DeliveryRow[] = [
      watchdog(18, 23, slot),
      { event: 'heartbeat_external', at: at(18, 25), ok: true },
      watchdog(18, 53, at(18, 47)),
    ]

    const report = heartbeatGaps({ cron: CRON, rows, holds: [], fromMs: at(18, 23), toMs: at(18, 53) })

    expect(report.doubles).toEqual([{ slot, events: ['heartbeat_watchdog', 'heartbeat_external'] }])
    expect(report.gaps).toEqual([])
  })

  // Catches: counting a send that failed as a delivery.
  it('ignores an external row whose send failed', () => {
    const rows: DeliveryRow[] = [
      watchdog(18, 23, at(18, 17)),
      { event: 'heartbeat_external', at: at(18, 25), ok: false },
    ]

    const report = heartbeatGaps({ cron: CRON, rows, holds: [], fromMs: at(18, 23), toMs: at(18, 25) })

    expect(report.deliveries).toBe(1)
    expect(report.doubles).toEqual([])
  })

  // Catches: dropping the hold exclusion, which would flag a seat that slept through its BUDGET-PAUSE.
  it('does not count a stretch inside a BUDGET-PAUSE as a gap', () => {
    const journal = '19:10 BUDGET-PAUSE 7d at 90% until 22:00\n'
    const holds = pauseHolds(journal, new Date(2026, 9, 10, 12))
    const rows = [watchdog(19, 23), watchdog(22, 2)]

    const report = heartbeatGaps({ cron: CRON, rows, holds, fromMs: at(19, 23), toMs: at(22, 2) })

    expect(report.gaps).toEqual([])
  })

  it('still reports the part of a gap outside the hold', () => {
    const holds = [{ fromMs: at(19, 23), toMs: at(20, 23) }]
    const rows = [watchdog(19, 23), watchdog(22, 2)]

    const report = heartbeatGaps({ cron: CRON, rows, holds, fromMs: at(19, 23), toMs: at(22, 2) })

    expect(report.gaps).toEqual([{ fromMs: at(19, 23), toMs: at(22, 2), minutes: 99 }])
  })

  it('reports a seat with no rows as one gap across the window', () => {
    const report = heartbeatGaps({ cron: CRON, rows: [], holds: [], fromMs: at(10, 0), toMs: at(12, 0) })

    expect(report.gaps).toEqual([{ fromMs: at(10, 0), toMs: at(12, 0), minutes: 120 }])
  })

  it('rejects a cron the report cannot place', () => {
    expect(() => heartbeatGaps({ cron: '0 3 * * *', rows: [], holds: [], fromMs: 0, toMs: MIN })).toThrow(
      /restricts hours/,
    )
  })
})

describe('pauseHolds', () => {
  it('runs a pause past midnight to the next day when the reset clock is earlier', () => {
    const holds = pauseHolds('23:10 BUDGET-PAUSE until 07:00\n09:00 tick: ok\n', new Date(2026, 9, 10, 12))

    expect(holds).toEqual([{ fromMs: at(23, 10), toMs: at(7, 0, 11) }])
  })
})
