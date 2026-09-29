import { describe, expect, it } from 'vitest'
import { EMPTY_LEDGER, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import { renderSeatEvents, seatEvents, type SeatEvent } from '../agents/burndown/seat-events.js'

const claim = (over: Partial<Claim> = {}): Claim => ({
  taskId: 'T-1',
  initiative: 'demo',
  spawnedAt: '2026-01-01T00:00:00.000Z',
  phase: 'implementing',
  phaseAt: '2026-01-01T00:00:00.000Z',
  seat: 'alpha',
  ...over,
})
const ledger = (...claims: Claim[]): Ledger => ({ ...EMPTY_LEDGER, claims })
const kinds = (l: Ledger, b: Ledger = ledger(), r: { key: { taskId: string }; ok: boolean }[] = []) =>
  (seatEvents(b, l, r).alpha ?? []).map(e => e.kind)

describe('seatEvents', () => {
  it('reports a delivered spawn as dispatched', () => {
    const after = ledger(claim({ phase: 'spawning' }))
    expect(kinds(after, ledger(), [{ key: { taskId: 'T-1' }, ok: true }])).toEqual(['dispatched'])
  })

  it('ignores a spawn that failed', () => {
    const after = ledger(claim({ phase: 'spawning' }))
    expect(kinds(after, ledger(), [{ key: { taskId: 'T-1' }, ok: false }])).toEqual([])
  })

  it('reports a move to awaiting-merge as ready-to-merge with the pr', () => {
    const before = ledger(claim({ phase: 'reviewing' }))
    const after = ledger(claim({ phase: 'awaiting-merge', pr: 'o/r#5' }))
    expect(seatEvents(before, after, []).alpha).toEqual([
      { kind: 'ready-to-merge', taskId: 'T-1', detail: 'o/r#5' },
    ])
  })

  it('reports a move to done as merged', () => {
    expect(kinds(ledger(claim({ phase: 'done' })), ledger(claim({ phase: 'awaiting-merge' })))).toEqual([
      'merged',
    ])
  })

  it('counts a shepherding to done transition as merged', () => {
    const before = ledger(claim({ phase: 'shepherding' as Claim['phase'] }))
    expect(kinds(ledger(claim({ phase: 'done' })), before)).toEqual(['merged'])
  })

  it('reports a newly stalled claim with its reason', () => {
    const after = ledger(claim({ stalledReason: 'timed out' }))
    expect(seatEvents(ledger(claim()), after, []).alpha).toEqual([
      { kind: 'stalled', taskId: 'T-1', detail: 'timed out' },
    ])
  })

  it('does not repeat a stall that was already there', () => {
    const both = ledger(claim({ stalledReason: 'timed out' }))
    expect(kinds(both, both)).toEqual([])
  })

  it('reports a move to parked', () => {
    expect(kinds(ledger(claim({ phase: 'parked' })), ledger(claim()))).toEqual(['parked'])
  })

  it('skips kinds the claim already notified', () => {
    const after = ledger(claim({ phase: 'parked', notified: ['parked'] }))
    expect(kinds(after, ledger(claim()))).toEqual([])
  })

  it('returns nothing for a claim without a seat', () => {
    const { seat: _seat, ...bare } = claim({ phase: 'parked' })
    expect(seatEvents(ledger(claim()), ledger(bare), [])).toEqual({})
  })

  it('groups events by seat', () => {
    const after = ledger(claim({ phase: 'parked' }), claim({ taskId: 'T-2', seat: 'beta', phase: 'parked' }))
    const before = ledger(claim(), claim({ taskId: 'T-2', seat: 'beta' }))
    expect(Object.keys(seatEvents(before, after, []))).toEqual(['alpha', 'beta'])
  })
})

describe('renderSeatEvents', () => {
  const now = new Date('2026-02-03T04:05:06.000Z')
  const event = (i: number, kind: SeatEvent['kind'] = 'parked'): SeatEvent => ({ kind, taskId: `T-${i}` })

  it('opens with the seat and ISO time, then one line per event', () => {
    const text = renderSeatEvents('alpha', [event(1), event(2, 'merged')], now)
    expect(text.split('\n')).toEqual([
      'Burndown events for alpha at 2026-02-03T04:05:06.000Z',
      'parked T-1',
      'merged T-2',
    ])
  })

  it('collapses overflow to counts and stays under 1,500 characters', () => {
    const events = Array.from({ length: 200 }, (_, i) => event(i, i % 2 === 0 ? 'parked' : 'merged'))
    const text = renderSeatEvents('alpha', events, now)
    const last = text.split('\n').at(-1) as string
    expect(text.length).toBeLessThan(1500)
    expect(last).toMatch(/^and \d+ more: \d+ merged, \d+ parked$/)
    const shown = text.split('\n').length - 2
    expect(Number(/^and (\d+)/.exec(last)?.[1]) + shown).toBe(200)
  })
})
