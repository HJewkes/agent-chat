import { describe, expect, it } from 'vitest'
import { readyOrder, readySet, type ReadyOrderRow, type ReadyTask } from '../agents/burndown/ready-order.js'

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
  const NOW = new Date('2026-10-10T12:00:00')
  const MAX_AGENTS = 3
  const check = { maxAgeDays: 30, now: NOW }
  const row = (id: string) => ({ ...r(id, 1), initiative: 'alpha' })
  const task = (id: string, priority: number, readyDay: string): ReadyTask => ({
    id,
    priority,
    tags: [`brief:ready=${readyDay}`],
  })
  const pickAll = (tasks: ReadyTask[], every: number): string[] => {
    const byId = new Map(tasks.map(t => [t.id, t]))
    let remaining = tasks.map(t => row(t.id))
    const picked: string[] = []
    while (remaining.length > 0) {
      const [next] = readySet(remaining, x => byId.get(x.id), check, undefined, {
        every,
        picks: picked.length,
      })
      picked.push(next!.id)
      remaining = remaining.filter(x => x.id !== next!.id)
    }
    return picked
  }
  const stream = (n: number): ReadyTask[] =>
    Array.from({ length: n }, (_, i) => task(`P1-${String(i).padStart(2, '0')}`, 1, '2026-10-10'))

  it('dispatches a priority-50 task ready for 3 days within maxAgents picks', () => {
    const tasks = [...stream(10), task('LOW', 50, '2026-10-07')]

    const picked = pickAll(tasks, MAX_AGENTS)

    expect(picked.indexOf('LOW')).toBeLessThan(MAX_AGENTS)
  })

  it('breaks a tie between equally old ready tasks by task id', () => {
    const tasks = [...stream(4), task('Z-9', 50, '2026-10-07'), task('B-2', 60, '2026-10-07')]

    const picked = pickAll(tasks, 2)

    expect(picked.slice(0, 4)).toEqual(['P1-00', 'B-2', 'P1-01', 'Z-9'])
  })

  it('keeps the order unchanged when no task has waited a day', () => {
    const tasks = [...stream(5), task('LOW', 50, '2026-10-10')]
    const byId = new Map(tasks.map(t => [t.id, t]))
    const rows = tasks.map(t => row(t.id))

    const plain = readySet(rows, x => byId.get(x.id), check)
    const aged = readySet(rows, x => byId.get(x.id), check, undefined, { every: MAX_AGENTS, picks: 2 })

    expect(aged.map(x => x.id)).toEqual(plain.map(x => x.id))
  })
})
