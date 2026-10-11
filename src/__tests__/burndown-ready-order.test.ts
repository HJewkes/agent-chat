import { describe, expect, it } from 'vitest'
import {
  agedFirst,
  agingTurn,
  briefReadyDay,
  readyOrder,
  type ReadyOrderRow,
  type ReadyTask,
} from '../agents/burndown/ready-order.js'

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

describe('aging slot (CC-928)', () => {
  const TODAY = Date.UTC(2026, 9, 10) / 86_400_000
  const MAX_AGENTS = 3
  const task = (id: string, priority: number, readyDay: string): ReadyTask => ({
    id,
    priority,
    tags: [`brief:ready=${readyDay}`],
  })
  const aged = (tasks: ReadyTask[]) => {
    const byId = new Map(tasks.map(t => [t.id, t]))
    const ordered = readyOrder(
      tasks.map(t => r(t.id, 1)),
      x => byId.get(x.id)?.priority,
    )
    return agedFirst(ordered, x => briefReadyDay(byId.get(x.id)!), TODAY).map(x => x.id)
  }
  const stream = (n: number): ReadyTask[] =>
    Array.from({ length: n }, (_, i) => task(`P1-${String(i).padStart(2, '0')}`, 1, '2026-10-10'))

  it('offers the aging slot to a priority-50 task ready for 3 days within maxAgents picks', () => {
    const tasks = [...stream(10), task('LOW', 50, '2026-10-07')]
    const turns = [0, 1, 2].filter(picks => agingTurn(picks, MAX_AGENTS))

    expect(turns).toHaveLength(1)
    expect(aged(tasks)[0]).toBe('LOW')
  })

  it('opens the slot on the last pick of each window', () => {
    expect([0, 1, 2, 3, 4, 5].map(picks => agingTurn(picks, 3))).toEqual([
      false,
      false,
      true,
      false,
      false,
      true,
    ])
  })

  it('breaks a tie between equally old ready tasks by task id', () => {
    const tasks = [...stream(3), task('Z-9', 50, '2026-10-07'), task('B-2', 60, '2026-10-07')]

    expect(aged(tasks)).toEqual(['B-2', 'Z-9'])
  })

  it('names no aged task when none has waited a day', () => {
    expect(aged([...stream(5), task('LOW', 50, '2026-10-10')])).toEqual([])
  })
})
