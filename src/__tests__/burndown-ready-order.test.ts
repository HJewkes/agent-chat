import { describe, expect, it } from 'vitest'
import { readyOrder, type ReadyOrderRow } from '../agents/burndown/ready-order.js'

const r = (id: string, score: number, patch: Partial<ReadyOrderRow> = {}): ReadyOrderRow => ({
  id,
  score,
  components: { W: 1 },
  ...patch,
})

const ids = (rows: ReadyOrderRow[]) => rows.map(x => x.id)

describe('readyOrder (CC-926)', () => {
  it('ranks by priority ascending whatever the scores', () => {
    const priorities: Record<string, number> = { A: 5, B: 1, C: 9 }
    const rows = [r('A', 10), r('B', 20), r('C', 30)].reverse()

    expect(ids(readyOrder(rows, x => priorities[x.id]))).toEqual(['B', 'A', 'C'])
  })

  it('breaks a priority tie by initiative weight, then score, then id', () => {
    const rows = [
      r('D', 5),
      r('C', 9),
      r('B', 9),
      r('A', 1, { components: { W: 2 } }),
      r('E', 1, { components: { W: 0.5 } }),
    ]

    expect(ids(readyOrder(rows, () => 1))).toEqual(['A', 'B', 'C', 'D', 'E'].map(x => x))
  })

  it('puts an expedite and a fixed-date row first, in the order given', () => {
    const rows = [
      r('P1', 1, { tier: 3 }),
      r('F', 1, { tier: 1 }),
      r('X', 1, { tier: 0 }),
      r('P2', 9, { tier: 2 }),
    ]
    const priorities: Record<string, number> = { P1: 1, F: 99, X: 99, P2: 2 }

    expect(ids(readyOrder(rows, x => priorities[x.id]))).toEqual(['F', 'X', 'P1', 'P2'])
  })

  it('puts a row with no priority last', () => {
    const rows = [r('A', 99), r('B', 1)]

    expect(ids(readyOrder(rows, x => (x.id === 'B' ? 7 : undefined)))).toEqual(['B', 'A'])
  })
})
