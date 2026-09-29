import { describe, expect, it } from 'vitest'
import { EMPTY_LEDGER, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import {
  MESSAGE_LIMIT,
  markNotified,
  settleNotified,
  renderSeatEvents,
  seatEvents,
  type EventKind,
  type SeatEvent,
} from '../agents/burndown/seat-events.js'

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

  it('reports a stall again while it is still undelivered', () => {
    const both = ledger(claim({ stalledReason: 'timed out' }))
    expect(kinds(both, both)).toEqual(['stalled'])
  })

  it('reports a move to parked', () => {
    expect(kinds(ledger(claim({ phase: 'parked' })), ledger(claim()))).toEqual(['parked'])
  })

  it('skips kinds the claim already notified', () => {
    const after = ledger(claim({ phase: 'parked', notified: ['parked'] }))
    expect(kinds(after, ledger(claim()))).toEqual([])
  })

  // One per kind: a claim already in that state before the tick, and already told, stays quiet.
  const settled: Record<EventKind, Partial<Claim>> = {
    dispatched: { agentId: 'id-1' },
    'ready-to-merge': { phase: 'awaiting-merge' },
    merged: { phase: 'done', notified: ['ready-to-merge'] },
    stalled: { stalledReason: 'timed out' },
    parked: { phase: 'parked' },
  }
  for (const [kind, state] of Object.entries(settled)) {
    it(`does not re-fire ${kind} for a claim already in that state and notified`, () => {
      const told = claim({ ...state, notified: [...(state.notified ?? []), kind] })
      expect(kinds(ledger(told), ledger(told))).toEqual([])
    })
  }

  it('reports merged on a retry once ready-to-merge was delivered', () => {
    const done = ledger(claim({ phase: 'done', notified: ['ready-to-merge'] }))
    expect(kinds(done, done)).toEqual(['merged'])
  })

  it('does not report merged for a claim done without a merge', () => {
    const done = ledger(claim({ phase: 'done' }))
    expect(kinds(done, ledger(claim({ phase: 'implementing' })))).toEqual([])
  })

  it('reports a landed agent as dispatched without a spawn result', () => {
    expect(kinds(ledger(claim({ agentId: 'id-1' })))).toEqual(['dispatched'])
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

describe('settleNotified', () => {
  it('drops parked and stalled once the claim leaves them, and keeps the rest', () => {
    const start = ledger(
      claim({ phase: 'implementing', notified: ['dispatched', 'parked', 'stalled'] }),
      claim({ taskId: 'T-2', phase: 'done', notified: ['ready-to-merge', 'merged'] }),
      claim({ taskId: 'T-3', phase: 'parked', notified: ['parked'] }),
    )
    expect(settleNotified(start).claims.map(c => c.notified)).toEqual([
      ['dispatched'],
      ['ready-to-merge', 'merged'],
      ['parked'],
    ])
  })
})

describe('markNotified', () => {
  it("adds delivered kinds to the seat's matching claims only", () => {
    const start = ledger(
      claim({ notified: ['dispatched'] }),
      claim({ taskId: 'T-2' }),
      claim({ seat: 'beta' }),
    )
    const marked = markNotified(start, 'alpha', [{ kind: 'parked', taskId: 'T-1' }])
    expect(marked.claims.map(c => c.notified)).toEqual([['dispatched', 'parked'], undefined, undefined])
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
    expect(last).toMatch(/^and \d+ more: \d+ merged, \d+ parked; run burndown status for them$/)
    const shown = text.split('\n').length - 2
    expect(Number(/^and (\d+)/.exec(last)?.[1]) + shown).toBe(200)
  })

  it('cuts a seat name too long for the bound and still shows the events', () => {
    const text = renderSeatEvents('s'.repeat(2000), [event(1)], now)
    expect(text.length).toBeLessThanOrEqual(MESSAGE_LIMIT)
    expect(text.split('\n')).toEqual([
      `Burndown events for ${'s'.repeat(100)}... at ${now.toISOString()}`,
      'parked T-1',
    ])
  })
})
