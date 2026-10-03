import { describe, expect, it } from 'vitest'
import { paceLine, paceOf, poolPace } from '../agents/seats/pace.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const RESET = Date.UTC(2026, 9, 10, 18, 0)
/** 72 h into the window that resets at RESET. */
const NOW = RESET - 4 * DAY
const RESERVE = 14

const at = (sevenDay: number, nowMs: number) => paceOf({ sevenDay, resetsAt: RESET }, RESERVE, nowMs)

describe('the pace of one pool reading', () => {
  it('targets half the day 7 line at mid-path and counts the points a day to reach it', () => {
    const pace = at(41, NOW)

    expect(pace).toMatchObject({ target: 49, behind: 8, needs: 19, level: 'behind', rolled: false })
  })

  it('is on pace above the glide path', () => {
    expect(at(60, NOW)).toMatchObject({ target: 49, behind: -11, level: 'on_pace' })
  })

  it('caps the target at the day 6 line', () => {
    expect(at(41, NOW + 71 * HOUR).target).toBe(96)
  })

  it('counts needs to the reset inside the last 24 h', () => {
    const pace = at(44, NOW + 84 * HOUR)

    expect(pace).toMatchObject({ target: 98, behind: 54, needs: 108, level: 'at_risk' })
  })

  it('reads 0 for the new window once the reset has passed', () => {
    const pace = at(93, NOW + 7 * DAY)

    expect(pace).toMatchObject({
      sevenDay: 0,
      target: 49,
      behind: 49,
      rolled: true,
      resetsAt: RESET + 7 * DAY,
    })
  })

  it('rolls a reset that passed several windows ago to the next one', () => {
    expect(at(93, RESET + 15 * DAY).resetsAt).toBe(RESET + 21 * DAY)
    expect(at(93, RESET).resetsAt).toBe(RESET + 7 * DAY)
  })

  it.each([
    [45, 'on_pace'],
    [44, 'behind'],
    [39, 'burn'],
  ])('at seven_day %i the level is %s', (sevenDay, level) => {
    expect(at(sevenDay, NOW).level).toBe(level)
  })

  it('is at risk when it needs over 28 points a day', () => {
    expect(at(13, NOW)).toMatchObject({ level: 'at_risk' })
    expect(at(14, NOW)).toMatchObject({ needs: 28, level: 'burn' })
  })
})

describe("a pool's pace row", () => {
  const reading = (ageSeconds: number, sevenDay = 41) => ({
    ageSeconds,
    sevenDay,
    fiveHour: 30,
    sevenDayResetsAt: RESET,
  })

  it('carries the reading, its age and the pace figures', () => {
    expect(poolPace('alpha', reading(180), RESERVE, NOW)).toEqual({
      pool: 'alpha',
      sevenDay: 41,
      fiveHour: 30,
      ageSeconds: 180,
      stale: false,
      resetsAt: RESET,
      target: 49,
      behind: 8,
      needs: 19,
      level: 'behind',
    })
  })

  it('gives a reading over 15 minutes old the level stale, never a pace level', () => {
    expect(poolPace('alpha', reading(900), RESERVE, NOW).level).toBe('behind')
    expect(poolPace('alpha', reading(901), RESERVE, NOW)).toMatchObject({ stale: true, level: 'stale' })
  })

  it('marks a reading from a window that has reset as stale at 0', () => {
    const row = poolPace('alpha', reading(60, 93), RESERVE, NOW + 7 * DAY)

    expect(row).toMatchObject({ sevenDay: 0, stale: true, level: 'stale', behind: 49 })
  })

  it('is no reading without one, or without a reset time', () => {
    expect(poolPace('alpha', undefined, RESERVE, NOW)).toMatchObject({ level: 'no_reading', target: null })
    const noReset = poolPace('alpha', { ageSeconds: 5, sevenDay: 41, fiveHour: 30 }, RESERVE, NOW)
    expect(noReset).toMatchObject({ level: 'no_reading', sevenDay: 41, ageSeconds: 5 })
  })

  it('prints as one PACE line', () => {
    expect(paceLine(poolPace('alpha', reading(180), RESERVE, NOW), NOW)).toBe(
      'alpha: 41 | target 49 | behind 8 | needs 19.0/day | 5h 30 | resets in 4d 0h | reading 3 min old',
    )
    expect(paceLine(poolPace('alpha', undefined, RESERVE, NOW), NOW)).toBe('alpha: no reading')
    expect(paceLine(poolPace('alpha', reading(1200, 60), RESERVE, NOW), NOW)).toContain('| on pace |')
    expect(paceLine(poolPace('alpha', reading(1200, 60), RESERVE, NOW), NOW)).toMatch(/20 min old STALE$/)
  })
})
