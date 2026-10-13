import { describe, expect, it } from 'vitest'
import type { SeatState } from '../agents/burndown/ledger.js'
import { poolSamples, seatSpend, type SeatSpendInput } from '../agents/burndown/spend-meter.js'

/** CC-1099: one rule picks a seat's spend source, ledger samples first and the watchdog meters as fallback. */

const HOUR = 3_600_000
const NOW = new Date(2026, 8, 29, 15)
const at = (hour: number, minute = 0) => new Date(2026, 8, 29, hour, minute).getTime()
const POOL = '/accounts/test-pool'
const RUN_SINCE = at(11)

// Meters advanced to the reading of 42 say run 8 and day 8.
const saved = {
  run: { since: RUN_SINCE, last: 40, spent: 6 },
  day: { since: at(7), last: 40, spent: 6 },
}

function spend(samples: SeatState['samples'], extra: Partial<SeatSpendInput> = {}) {
  return seatSpend({
    seatState: { samples, configDir: POOL },
    configDir: POOL,
    saved,
    sevenDay: 42,
    now: NOW,
    ...extra,
  })
}

describe('seatSpend', () => {
  it('counts from the ledger when its samples reach back to the run start', () => {
    const result = spend([
      { at: at(6, 30), sevenDay: 10 },
      { at: at(10, 30), sevenDay: 20 },
      { at: at(14), sevenDay: 40 },
    ])
    expect(result).toMatchObject({ source: 'ledger', runStart: RUN_SINCE, run: 22, day: 32 })
  })

  it('counts a ledger sample taken exactly at the run start as reaching it', () => {
    const result = spend([
      { at: RUN_SINCE, sevenDay: 25 },
      { at: at(14), sevenDay: 40 },
    ])
    expect(result).toMatchObject({ source: 'ledger', run: 17, day: 17 })
  })

  it("counts the day from the day's first ledger sample when none is at or before 07:00 (CC-1190)", () => {
    const result = spend(
      [
        { at: at(8), sevenDay: 20 },
        { at: RUN_SINCE, sevenDay: 22 },
      ],
      { sevenDay: 25 },
    )
    expect(result).toMatchObject({ source: 'ledger', run: 3, day: 5 })
  })

  it('falls back to the meters when the ledger samples start after the run start', () => {
    const result = spend([
      { at: at(12), sevenDay: 30 },
      { at: at(14), sevenDay: 40 },
    ])
    expect(result).toMatchObject({ source: 'meters', run: 8, day: 8 })
    expect(result.dayMeter).toEqual({ since: at(7), last: 42, spent: 8 })
  })

  it('falls back to the meters when the samples were read from another pool, never mixing the two', () => {
    const result = spend([{ at: at(6, 30), sevenDay: 90 }], {
      seatState: { samples: [{ at: at(6, 30), sevenDay: 90 }], configDir: '/accounts/other-pool' },
    })
    expect(result).toMatchObject({ source: 'meters', run: 8, day: 8 })
    expect(result.history.every(s => s.sevenDay !== 90)).toBe(true)
  })

  it('falls back to the meters for a seat with no ledger state', () => {
    expect(spend([], { seatState: undefined })).toMatchObject({ source: 'meters', run: 8, day: 8 })
  })

  it('ignores ledger samples older than the keep window', () => {
    const result = spend([{ at: NOW.getTime() - 27 * HOUR, sevenDay: 1 }])
    expect(result.source).toBe('meters')
  })

  it('reports no figures without a reading', () => {
    const result = spend([{ at: at(6, 30), sevenDay: 10 }], { sevenDay: undefined })
    expect(result).toMatchObject({ source: 'ledger', run: undefined, day: undefined })
  })

  it("keeps the meters' history without a reading when the ledger cannot reach the run start", () => {
    const result = spend([{ at: at(12), sevenDay: 30 }], { sevenDay: undefined })
    expect(result).toMatchObject({ source: 'meters', run: undefined, day: undefined })
    expect(result.history.length).toBeGreaterThan(0)
  })
})

describe('poolSamples across config dir key forms (CC-1118)', () => {
  const HOME = '/h'
  const samples = [{ at: at(10), sevenDay: 20 }]
  const keep = (key: string | undefined, configDir: string) =>
    poolSamples({ samples, configDir: key }, configDir, NOW.getTime(), HOME)

  it('keeps samples keyed ~/ when the pool dir is absolute', () => {
    expect(keep('~/agents', '/h/agents')).toEqual(samples)
  })

  it('keeps samples keyed absolute when the pool dir is written ~/', () => {
    expect(keep('/h/agents', '~/agents')).toEqual(samples)
  })

  it('keeps samples whose key differs only by a trailing slash', () => {
    expect(keep('/h/agents/', '/h/agents')).toEqual(samples)
  })

  it("drops another pool's samples", () => {
    expect(keep('~/other', '/h/agents')).toEqual([])
  })

  it('drops an unkeyed ledger', () => {
    expect(keep(undefined, '/h/agents')).toEqual([])
  })

  it('seatSpend counts a ~/-keyed ledger against an absolute pool dir with the given home', () => {
    const result = spend([{ at: at(6, 30), sevenDay: 10 }], {
      seatState: { samples: [{ at: at(6, 30), sevenDay: 10 }], configDir: '~/agents' },
      configDir: '/h/agents',
      home: HOME,
    })
    expect(result).toMatchObject({ source: 'ledger', run: 32 })
  })
})
