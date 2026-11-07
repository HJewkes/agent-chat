import { describe, expect, it } from 'vitest'
import { LOOP_STALL_EVENT, loopStallMonitor } from '../broker/loop-stall.js'
import { loopLine } from '../cli/service.js'

const TICK = 500
const STALL = 1_000

function clocked() {
  let clock = 1_000_000
  const logged: Array<[string, Record<string, unknown>]> = []
  const monitor = loopStallMonitor({ log: (e, d) => logged.push([e, d]), now: () => clock }, TICK, STALL)
  return { monitor, logged, advance: (ms: number) => (clock += ms), now: () => clock }
}

describe('the event-loop stall monitor (CC-1699)', () => {
  it('counts nothing while ticks arrive on time or a little late', () => {
    const { monitor, logged, advance } = clocked()

    for (const late of [0, 40, 900]) {
      advance(TICK + late)
      monitor.tick()
    }

    expect(monitor.health()).toEqual({ stalls: 0, worst_ms: 0 })
    expect(logged).toEqual([])
  })

  it('logs and reports a tick held back by a blocked loop, with its length', () => {
    const { monitor, logged, advance, now } = clocked()

    advance(TICK + 29_800)
    monitor.tick()
    advance(TICK)
    monitor.tick()
    advance(TICK + 1_200)
    monitor.tick()

    expect(monitor.health()).toEqual({ stalls: 2, worst_ms: 29_800, last_ms: 1_200, last_at: now() })
    expect(logged).toEqual([
      [LOOP_STALL_EVENT, { blockedMs: 29_800, stalls: 1 }],
      [LOOP_STALL_EVENT, { blockedMs: 1_200, stalls: 2 }],
    ])
  })
})

describe('the loop line of service status', () => {
  it('says there was no block', () => {
    expect(loopLine({ stalls: 0, worst_ms: 0 }, 0)).toBe('loop     no block of 1000 ms or more since start')
  })

  it('names the worst and the latest block and how long ago', () => {
    const line = loopLine({ stalls: 3, worst_ms: 29_800, last_ms: 1_200, last_at: 10_000 }, 52_000)

    expect(line).toContain('3 block(s)')
    expect(line).toContain('worst 29800 ms')
    expect(line).toContain('last 1200 ms, 42s ago')
  })
})
