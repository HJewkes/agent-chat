import { describe, expect, it } from 'vitest'
import { dispatchTicks, exitToDispatch } from '../agents/burndown/exit-latency.js'

const T0 = Date.parse('2026-10-11T12:00:00.000Z')
const MIN = 60_000

const tickRow = (atMs: number, dispatched: Record<string, number>): string =>
  JSON.stringify({
    v: 1,
    ts: new Date(atMs).toISOString(),
    registrations: { ok: 0, refused: 0, failed: 0 },
    seats: Object.fromEntries(Object.entries(dispatched).map(([seat, n]) => [seat, { dispatched: n }])),
  })

describe('exit-to-dispatch latency', () => {
  it('reads only v1 rows that dispatched, summed across seats', () => {
    const text = [
      tickRow(T0, { a: 0 }),
      tickRow(T0 + MIN, { a: 1, b: 2 }),
      JSON.stringify({ v: 2, ts: new Date(T0).toISOString(), seats: { a: { dispatched: 5 } } }),
      'not json',
      '',
    ].join('\n')

    expect(dispatchTicks(text)).toEqual([{ atMs: T0 + MIN, dispatched: 3 }])
  })

  it('gives each exit its own dispatch, so two exits do not share one slot fill', () => {
    const ticks = [
      { atMs: T0 + 1 * MIN, dispatched: 1 },
      { atMs: T0 + 4 * MIN, dispatched: 1 },
    ]
    const exits = [
      { agentId: 'a', atMs: T0 },
      { agentId: 'b', atMs: T0 },
    ]

    expect(exitToDispatch(exits, ticks)).toEqual({ samples: 2, unmatched: 0, medianMs: 2.5 * MIN })
  })

  it('counts an agent that exited and was retired once, at its first row', () => {
    const ticks = [{ atMs: T0 + 2 * MIN, dispatched: 2 }]
    const exits = [
      { agentId: 'a', atMs: T0 + MIN },
      { agentId: 'a', atMs: T0 },
    ]

    expect(exitToDispatch(exits, ticks)).toEqual({ samples: 1, unmatched: 0, medianMs: 2 * MIN })
  })

  it('leaves an exit with no dispatch inside the wait cap out of the median', () => {
    const ticks = [{ atMs: T0 + 45 * MIN, dispatched: 1 }]
    const exits = [{ agentId: 'a', atMs: T0 }]

    expect(exitToDispatch(exits, ticks, 30 * MIN)).toEqual({ samples: 0, unmatched: 1, medianMs: undefined })
  })
})
