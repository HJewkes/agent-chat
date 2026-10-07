import { describe, expect, it } from 'vitest'
import { EMPTY_LEDGER, type Claim, type Ledger } from '../agents/burndown/ledger.js'
import {
  MESSAGE_LIMIT,
  foldBraked,
  markNotified,
  settleNotified,
  renderSeatEvents,
  seatEvents,
  type EventKind,
  type SeatEvent,
} from '../agents/burndown/seat-events.js'
import type { StallCode } from '../agents/burndown/stall-code.js'

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
const finding: NonNullable<Claim['finding']> = {
  kind: 'stalled-after-claim',
  reason: 'idle',
  since: '2026-01-01T00:01:00.000Z',
  openedAt: '2026-01-01T00:07:00.000Z',
  checkedAt: '2026-01-01T00:07:00.000Z',
  detail: 'idle: no agent event for 6 min since 2026-01-01T00:01:00.000Z',
}
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
    'stalled-after-claim': { finding },
    parked: { phase: 'parked' },
    // These two are told from a ledger diff, never from claim state.
    released: {},
    brake: {},
    leak: {
      leak: {
        repo: 'example/repo',
        url: 'https://github.com/example/repo/pull/1',
        findings: ['body:1 home-path'],
      },
    },
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

describe('the stalled-after-claim notice', () => {
  /** One tick as the seat sees it: settle, diff, and mark whatever was due as delivered. */
  const deliver = (before: Ledger, after: Ledger): { sent: SeatEvent[]; ledger: Ledger } => {
    const settled = settleNotified(after)
    const sent = seatEvents(before, settled, []).alpha ?? []
    return { sent, ledger: markNotified(settled, 'alpha', sent) }
  }

  it('fires once with the finding detail while the finding stays open', () => {
    const open = ledger(claim({ finding }))

    const first = deliver(ledger(claim()), open)
    const second = deliver(first.ledger, ledger({ ...first.ledger.claims[0]!, finding }))

    expect(first.sent).toEqual([{ kind: 'stalled-after-claim', taskId: 'T-1', detail: finding.detail }])
    expect(second.sent).toEqual([])
  })

  const lease = (over: Partial<NonNullable<Claim['lease']>> = {}): NonNullable<Claim['lease']> => ({
    progressAt: '2026-01-01T00:00:00.000Z',
    leaseUntil: '2026-01-01T00:30:00.000Z',
    renewals: 0,
    head: 'aaaa111',
    content: 'tree-1',
    ...over,
  })
  /** One close and one reopen of the claim's finding, with `over` applied to the reopened claim. */
  const cycle = (from: Ledger, over: Partial<Claim> = {}): ReturnType<typeof deliver> => {
    const { finding: _closed, ...closedClaim } = from.claims[0]!
    const closed = deliver(from, ledger(closedClaim))
    return deliver(closed.ledger, ledger({ ...closed.ledger.claims[0]!, finding, ...over }))
  }
  const told = (): Ledger =>
    deliver(ledger(claim()), ledger(claim({ agentName: 'bd-T-1', lease: lease(), finding }))).ledger

  it('two ticks with an unchanged stalled claim send one wake', () => {
    const reopened = cycle(told())

    expect(reopened.ledger.claims[0]?.notified).toBeUndefined()
    expect(reopened.sent).toEqual([])
  })

  it("a new commit on the claim's branch changes the fingerprint", () => {
    const committed = cycle(told(), { lease: lease({ head: 'bbbb222' }) })
    const again = cycle(committed.ledger)

    expect(committed.sent.map(e => e.kind)).toEqual(['stalled-after-claim'])
    expect(again.sent).toEqual([])
  })

  it("the tick's own notes are excluded", () => {
    const notes = cycle(told(), {
      finding: { ...finding, detail: 'idle: no agent event for 12 min', since: 'later', checkedAt: 'later' },
      lease: lease({ renewals: 4, transcriptAt: '2026-01-01T00:20:00.000Z', progressAt: 'later' }),
      notified: ['dispatched'],
    })

    expect(notes.sent).toEqual([])
  })

  it('an uncommitted edit re-arms the notice', () => {
    const edited = cycle(told(), { lease: lease({ content: 'tree-2' }) })
    const again = cycle(edited.ledger)

    expect(edited.sent.map(e => e.kind)).toEqual(['stalled-after-claim'])
    expect(again.sent).toEqual([])
  })

  const coded = (code: StallCode): NonNullable<Claim['finding']> => ({
    ...finding,
    code,
    detail: `${code}: ${finding.detail}`,
  })

  it('fires once per code across repeat ticks and records the code in notified', () => {
    const first = deliver(ledger(claim()), ledger(claim({ finding: coded('no-progress') })))
    const second = deliver(
      first.ledger,
      ledger({ ...first.ledger.claims[0]!, finding: coded('no-progress') }),
    )

    expect(first.sent).toEqual([
      {
        kind: 'stalled-after-claim',
        taskId: 'T-1',
        detail: coded('no-progress').detail,
        code: 'no-progress',
      },
    ])
    expect(second.sent).toEqual([])
    expect(second.ledger.claims[0]?.notified).toEqual(['stalled-after-claim:no-progress'])
  })

  it('fires once more when the open finding changes code', () => {
    const first = deliver(ledger(claim()), ledger(claim({ finding: coded('no-progress') })))
    const changed = deliver(
      first.ledger,
      ledger({ ...first.ledger.claims[0]!, finding: coded('lease-expired') }),
    )

    expect(changed.sent.map(e => e.code)).toEqual(['lease-expired'])
    expect(changed.ledger.claims[0]?.notified).toEqual(['stalled-after-claim:lease-expired'])
  })

  it('sends nothing for a claim told before codes existed', () => {
    const findingTold = claim({ finding: coded('no-progress'), notified: ['stalled-after-claim'] })
    const stallTold = claim({
      taskId: 'T-2',
      stalledReason: 'implementing past its timeout',
      stallCode: 'phase-timeout',
      notified: ['stalled'],
    })
    const both = ledger(findingTold, stallTold)

    expect(deliver(both, both).sent).toEqual([])
  })
})

describe('the stalled notice', () => {
  it('starts its detail with the code and records the code once delivered', () => {
    const stalled = claim({ stalledReason: 'implementing past its timeout', stallCode: 'phase-timeout' })

    const sent = seatEvents(ledger(claim()), ledger(stalled), []).alpha ?? []
    const marked = markNotified(ledger(stalled), 'alpha', sent)

    expect(sent).toEqual([
      {
        kind: 'stalled',
        taskId: 'T-1',
        detail: 'phase-timeout: implementing past its timeout',
        code: 'phase-timeout',
      },
    ])
    expect(seatEvents(marked, marked, []).alpha).toBeUndefined()
    expect(marked.claims[0]?.notified).toEqual(['stalled:phase-timeout'])
  })

  it('a stalled notice of the same code with unchanged facts is not re-sent', () => {
    const stalled = claim({ stalledReason: 'implementing past its timeout', stallCode: 'phase-timeout' })
    const marked = markNotified(
      ledger(stalled),
      'alpha',
      seatEvents(ledger(claim()), ledger(stalled), []).alpha ?? [],
    )
    const { stalledReason: _r, stallCode: _c, ...cleared } = marked.claims[0]!
    const settled = settleNotified(ledger(cleared))

    const again = ledger({
      ...settled.claims[0]!,
      stalledReason: 'implementing past its timeout again',
      stallCode: 'phase-timeout',
    })

    expect(settled.claims[0]?.notified).toBeUndefined()
    expect(seatEvents(settled, settleNotified(again), []).alpha).toBeUndefined()
  })

  it('a brake-covered stall with unchanged facts is not re-sent', () => {
    const stalled = claim({ stalledReason: 'implementing past its timeout', stallCode: 'phase-timeout' })
    const marked = markNotified(
      ledger(stalled),
      'alpha',
      seatEvents(ledger(claim()), ledger(stalled), []).alpha ?? [],
    )
    const { notified: _told, ...again } = marked.claims[0]!
    const before = ledger(again)
    const braked: Ledger = {
      ...before,
      brake: { at: ['2026-01-01T00:10:00.000Z'], notified: 'brake:phase-timeout', claims: ['T-1#'] },
    }

    const events = foldBraked(seatEvents(before, braked, []), before, braked).alpha ?? []

    expect(events.map(e => [e.kind, (e.covers ?? []).length])).toEqual([['brake', 0]])
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
