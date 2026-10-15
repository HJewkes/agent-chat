import { describe, expect, it } from 'vitest'
import type { PoolPace } from '../agents/seats/pace.js'
import { changedReadings, type PaceDoc } from '../agents/seats/pace-pass.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = new Date(2026, 9, 15, 0, 20).getTime()
const RESET = NOW + 3 * DAY

const pace = (sevenDay: number, resetsAt: number): PoolPace => ({
  pool: 'workout',
  sevenDay,
  fiveHour: 4,
  ageSeconds: 10,
  stale: false,
  resetsAt,
  target: null,
  behind: null,
  needs: null,
  level: 'on_pace',
})

const previousAt = (sevenDay: number, resetsAt: number): PaceDoc => ({
  at: NOW - 60_000,
  pools: { workout: { ...pace(sevenDay, resetsAt), passesAtLevel: 1 } },
})

describe('the reading history under a seven_day fall (CC-1364)', () => {
  it('a seven_day fall before the window reset is not appended', () => {
    const rows = changedReadings(previousAt(93, RESET), [pace(74, RESET)], NOW)

    expect(rows).toEqual([])
  })

  it('a fall under a resets_at that moved under an hour is still the same window', () => {
    const rows = changedReadings(previousAt(93, RESET), [pace(74, RESET + 30 * 60_000)], NOW)

    expect(rows).toEqual([])
  })

  it('a fall past the reset is appended', () => {
    const rows = changedReadings(previousAt(93, RESET), [pace(74, RESET)], RESET + 1)

    expect(rows.map(row => row.seven_day)).toEqual([74])
  })

  it('a fall with a later resets_at is appended', () => {
    const rows = changedReadings(previousAt(93, RESET), [pace(2, RESET + 7 * DAY)], NOW)

    expect(rows.map(row => [row.seven_day, row.resets_at])).toEqual([
      [2, Math.round((RESET + 7 * DAY) / 1000)],
    ])
  })

  it('a rolled row is appended though it reads lower', () => {
    const rolled: PoolPace = { ...pace(0, RESET), rolled: true }

    const rows = changedReadings(previousAt(93, RESET), [rolled], NOW)

    expect(rows.map(row => [row.seven_day, row.rolled])).toEqual([[0, true]])
  })

  it('a rise is appended as before', () => {
    const rows = changedReadings(previousAt(74, RESET), [pace(93, RESET)], NOW)

    expect(rows.map(row => row.seven_day)).toEqual([93])
  })
})
