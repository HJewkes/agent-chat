import { describe, expect, it } from 'vitest'
import { FINISH_EARLY_MS, PACE_BUFFER_POINTS, paceVerdict } from '../agents/seats/pace.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const RESET = Date.UTC(2026, 9, 10, 18, 0)
/** 72 h into the window that resets at RESET: the glide target is 49 for a reserve of 14. */
const NOW = RESET - 4 * DAY
const RESERVE = 14
const TARGET = 49

const verdict = (sevenDay: number, charged = 0, nowMs = NOW) =>
  paceVerdict({ sevenDay, resetsAt: RESET }, RESERVE, nowMs, charged)

describe('the pace controller verdict for one pool', () => {
  it.each([
    { scenario: 'on the glide', sevenDay: TARGET, charged: 0, open: true, headroom: PACE_BUFFER_POINTS },
    {
      scenario: 'a buffer ahead of the glide',
      sevenDay: TARGET + PACE_BUFFER_POINTS,
      charged: 0,
      open: false,
      headroom: 0,
    },
    {
      scenario: 'behind the glide',
      sevenDay: 41,
      charged: 0,
      open: true,
      headroom: TARGET + PACE_BUFFER_POINTS - 41,
    },
    {
      scenario: 'just under the buffer before the charge',
      sevenDay: 50,
      charged: 0,
      open: true,
      headroom: 2,
    },
    { scenario: 'tipped over the buffer by the charge', sevenDay: 50, charged: 2, open: false, headroom: 0 },
  ])('is $open $scenario', ({ sevenDay, charged, open, headroom }) => {
    const result = verdict(sevenDay, charged)

    expect(result).toMatchObject({
      open,
      lever: 'pace',
      value: TARGET + PACE_BUFFER_POINTS,
      reading: sevenDay + charged,
      headroom,
      source: 'glide',
    })
  })

  it('judges a passed reset from 0 in the new window', () => {
    const result = verdict(93, 0, NOW + 7 * DAY)

    expect(result).toMatchObject({
      open: true,
      reading: 0,
      value: TARGET + PACE_BUFFER_POINTS,
      source: 'rolled',
    })
  })

  it('never refuses a reading with no reset time', () => {
    const result = paceVerdict({ sevenDay: 99, resetsAt: undefined }, RESERVE, NOW, 2)

    expect(result).toEqual({
      open: true,
      lever: 'pace',
      value: null,
      reading: 101,
      headroom: null,
      needs: null,
      source: 'no-reset',
    })
  })

  it('needs the glide rate when on the glide at mid-week, so the level and rate forms agree', () => {
    const glideRate = (100 - RESERVE / 7) / ((7 * DAY - FINISH_EARLY_MS) / DAY)

    const result = verdict(TARGET)

    expect(Math.abs((result.needs ?? 0) - glideRate)).toBeLessThan(1)
  })
})
