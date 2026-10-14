import { describe, expect, it } from 'vitest'
import { DEFAULT_DISPATCH_COST } from '../agents/burndown/budget-gate.js'
import { COST_FLOOR, observedDispatchCost, type CostReading } from '../agents/burndown/dispatch-cost.js'

/** CC-1038 a: the per-dispatch cost a pool's own reading history shows. */

const NOW = Date.parse('2026-10-11T13:40:00Z')
const at = (hhmm: string): number => Date.parse(`2026-10-11T${hhmm}:00Z`)
const reading = (hhmm: string, fiveHour: number, sevenDay: number): CostReading => ({
  at: at(hhmm),
  fiveHour,
  sevenDay,
})
/** `count` spawns spread evenly from `from` to `to`, inclusive. */
const spawns = (count: number, from: string, to: string): number[] =>
  Array.from(
    { length: count },
    (_, i) => at(from) + Math.round(((at(to) - at(from)) * i) / Math.max(1, count - 1)),
  )

const RAMP = [
  reading('12:23', 28, 24),
  reading('12:53', 37, 25),
  reading('13:23', 46, 27),
  reading('13:38', 52, 28),
]

describe('observedDispatchCost', () => {
  it('divides the five_hour rise over the window by the spawns, not by the readings', () => {
    const cost = observedDispatchCost(RAMP, spawns(69, '12:00', '13:20'), NOW)

    expect(cost?.fiveHour).toBeCloseTo(24 / 69, 3)
    expect(cost?.sevenDay).toBeCloseTo(4 / 69, 3)
    expect(cost?.basis).toBe('observed: 69 spawns, +24 five_hour +4 seven_day over 12:23-13:38Z')
  })

  it('counts a drop in the window as a reset from zero', () => {
    const resetting = [reading('11:00', 45, 20), reading('11:30', 0, 20), reading('12:30', 7, 21)]

    const cost = observedDispatchCost(resetting, spawns(10, '11:00', '13:00'), NOW)

    expect(cost?.fiveHour).toBeCloseTo(0.7, 5)
  })

  it('gives no estimate under ten spawns', () => {
    expect(observedDispatchCost(RAMP, spawns(9, '12:00', '13:20'), NOW)).toBeUndefined()
    expect(observedDispatchCost(RAMP, spawns(10, '12:00', '13:20'), NOW)).toBeDefined()
  })

  it('leaves out spawns from the last fifteen minutes, which have not spent yet', () => {
    const tooNew = spawns(5, '13:26', '13:39')

    expect(observedDispatchCost(RAMP, [...spawns(9, '12:00', '13:20'), ...tooNew], NOW)).toBeUndefined()
  })

  it('gives no estimate when the readings span under an hour', () => {
    const short = [reading('13:00', 40, 26), reading('13:38', 52, 28)]

    expect(observedDispatchCost(short, spawns(69, '12:00', '13:20'), NOW)).toBeUndefined()
  })

  it('clamps a steep rise to the default charge', () => {
    const steep = [reading('12:00', 0, 0), reading('13:30', 100, 100)]

    const cost = observedDispatchCost(steep, spawns(10, '12:00', '13:20'), NOW)

    expect(cost?.fiveHour).toBe(DEFAULT_DISPATCH_COST.fiveHour)
    expect(cost?.sevenDay).toBe(DEFAULT_DISPATCH_COST.sevenDay)
  })

  it('never charges less than the floor on a flat pool', () => {
    const flat = [reading('12:00', 30, 20), reading('13:30', 30, 20)]

    const cost = observedDispatchCost(flat, spawns(20, '12:00', '13:20'), NOW)

    expect(cost).toMatchObject(COST_FLOOR)
  })

  it('ignores readings older than the five-hour window', () => {
    const withOld = [reading('07:00', 0, 0), ...RAMP]

    expect(observedDispatchCost(withOld, spawns(69, '12:00', '13:20'), NOW)?.fiveHour).toBeCloseTo(24 / 69, 3)
  })
})
