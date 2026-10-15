import { describe, expect, it } from 'vitest'
import { stepTimer } from '../agents/burndown/step-timer.js'

/** CC-1192: the tick's per-stage timer. */

const advancingBy = (ms: number): (() => number) => {
  let t = 0
  return () => {
    const read = t
    t += ms
    return read
  }
}

describe('the burndown step timer', () => {
  it('records each stage in completion order with its elapsed ms', async () => {
    const timer = stepTimer(advancingBy(7))

    await timer.time('roster', () => 'r')
    await timer.time('world', () => 'w')

    expect(timer.steps()).toEqual([
      { name: 'roster', ms: 7 },
      { name: 'world', ms: 7 },
    ])
  })

  it('returns the value the stage resolves to', async () => {
    const timer = stepTimer(advancingBy(1))

    const value = await timer.time('observe', async () => ({ observed: 3 }))

    expect(value).toEqual({ observed: 3 })
  })

  it('records a stage that throws and rethrows its error', async () => {
    const timer = stepTimer(advancingBy(4))

    const failing = timer.time('collision', () => {
      throw new Error('gh down')
    })

    await expect(failing).rejects.toThrow('gh down')
    expect(timer.steps()).toEqual([{ name: 'collision', ms: 4 }])
  })

  it('folds a stage timed twice into one entry at its first place', async () => {
    const timer = stepTimer(advancingBy(3))

    const planning = timer.start('plan')
    planning.stop()
    await timer.time('collision', () => undefined)
    const building = timer.start('plan')
    building.stop()

    expect(timer.steps()).toEqual([
      { name: 'plan', ms: 6 },
      { name: 'collision', ms: 3 },
    ])
  })
})
