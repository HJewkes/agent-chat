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
import { localDate } from '../agents/burndown/seat-tick.js'
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
/** Half an hour after the fixtures' phase change, so their stalls are not yet aged. */
const FRESH = { now: new Date('2026-01-01T00:30:00.000Z') }
const seatEventsAt = (before: Ledger, after: Ledger, spawns: Parameters<typeof seatEvents>[2]) =>
  seatEvents(before, after, spawns, {}, FRESH)
const finding: NonNullable<Claim['finding']> = {
  kind: 'stalled-after-claim',
  reason: 'idle',
  since: '2026-01-01T00:01:00.000Z',
  openedAt: '2026-01-01T00:07:00.000Z',
  checkedAt: '2026-01-01T00:07:00.000Z',
  detail: 'idle: no agent event for 6 min since 2026-01-01T00:01:00.000Z',
}
const kinds = (l: Ledger, b: Ledger = ledger(), r: { key: { taskId: string }; ok: boolean }[] = []) =>
  (seatEventsAt(b, l, r).alpha ?? []).map(e => e.kind)

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
    expect(seatEventsAt(before, after, []).alpha).toEqual([
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
    expect(seatEventsAt(ledger(claim()), after, []).alpha).toEqual([
      { kind: 'stalled', taskId: 'T-1', detail: 'timed out; holds: lane + task; class unclassed' },
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
    'stall-aged': {
      stalledReason: 'timed out',
      stalledAt: '2025-12-31T20:00:00.000Z',
      notified: ['stalled', `stall-aged@${localDate(FRESH.now)}`],
    },
    'stalled-after-claim': { finding },
    parked: { phase: 'parked' },
    stale: { stale: { class: 'other', proposed: 'settle by hand', since: '2026-01-01T01:00:00.000Z' } },
    // These are told from a ledger diff or the task's slices, never from one claim's state.
    released: {},
    brake: {},
    'slices-merged': {},
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
    expect(seatEventsAt(ledger(claim()), ledger(bare), [])).toEqual({})
  })

  it('groups events by seat', () => {
    const after = ledger(claim({ phase: 'parked' }), claim({ taskId: 'T-2', seat: 'beta', phase: 'parked' }))
    const before = ledger(claim(), claim({ taskId: 'T-2', seat: 'beta' }))
    expect(Object.keys(seatEventsAt(before, after, []))).toEqual(['alpha', 'beta'])
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
    const sent = seatEventsAt(before, settled, []).alpha ?? []
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

    const sent = seatEventsAt(ledger(claim()), ledger(stalled), []).alpha ?? []
    const marked = markNotified(ledger(stalled), 'alpha', sent)

    expect(sent).toEqual([
      {
        kind: 'stalled',
        taskId: 'T-1',
        detail: 'phase-timeout: implementing past its timeout; holds: lane + task; class unclassed',
        code: 'phase-timeout',
      },
    ])
    expect(seatEventsAt(marked, marked, []).alpha).toBeUndefined()
    expect(marked.claims[0]?.notified).toEqual(['stalled:phase-timeout'])
  })

  it('a stalled notice of the same code with unchanged facts is not re-sent', () => {
    const stalled = claim({ stalledReason: 'implementing past its timeout', stallCode: 'phase-timeout' })
    const marked = markNotified(
      ledger(stalled),
      'alpha',
      seatEventsAt(ledger(claim()), ledger(stalled), []).alpha ?? [],
    )
    const { stalledReason: _r, stallCode: _c, ...cleared } = marked.claims[0]!
    const settled = settleNotified(ledger(cleared))

    const again = ledger({
      ...settled.claims[0]!,
      stalledReason: 'implementing past its timeout again',
      stallCode: 'phase-timeout',
    })

    expect(settled.claims[0]?.notified).toBeUndefined()
    expect(seatEventsAt(settled, settleNotified(again), []).alpha).toBeUndefined()
  })

  it('a brake-covered stall with unchanged facts is not re-sent', () => {
    const stalled = claim({ stalledReason: 'implementing past its timeout', stallCode: 'phase-timeout' })
    const marked = markNotified(
      ledger(stalled),
      'alpha',
      seatEventsAt(ledger(claim()), ledger(stalled), []).alpha ?? [],
    )
    const { notified: _told, ...again } = marked.claims[0]!
    const before = ledger(again)
    const braked: Ledger = {
      ...before,
      brake: { at: ['2026-01-01T00:10:00.000Z'], notified: 'brake:phase-timeout', claims: ['T-1#'] },
    }

    const events = foldBraked(seatEventsAt(before, braked, []), before, braked).alpha ?? []

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

describe('the stale notice (CC-1150 b)', () => {
  const stale: NonNullable<Claim['stale']> = {
    class: 'blocked',
    proposed: 'answer the question or release by hand',
    since: '2026-01-01T01:00:00.000Z',
  }

  it('tells a claim that gains a stale class once, and not again while it holds', () => {
    const before = ledger(claim({ stalledReason: 'Status: BLOCKED', notified: ['stalled'] }))
    const after = ledger(claim({ stalledReason: 'Status: BLOCKED', notified: ['stalled'], stale }))

    const sent = seatEventsAt(before, after, []).alpha ?? []
    const marked = markNotified(after, 'alpha', sent)
    const next = settleNotified(marked)

    expect(sent).toEqual([
      { kind: 'stale', taskId: 'T-1', detail: 'blocked: proposed answer the question or release by hand' },
    ])
    expect(next.claims[0]?.notified).toEqual(['stalled', 'stale'])
    expect(seatEventsAt(marked, next, []).alpha).toBeUndefined()
  })

  it('tells it again once the class cleared and a later stall gains one', () => {
    const told = ledger(claim({ stalledReason: 'x', stale, notified: ['stale'] }))
    const cleared = settleNotified(ledger(claim({ notified: ['stale'] })))
    const again = ledger(claim({ ...cleared.claims[0], stalledReason: 'y', stale }))

    expect(cleared.claims[0]?.notified).toBeUndefined()
    expect(kinds(again, told)).toEqual(['stalled', 'stale'])
  })
})

describe('the stall hold and the aged stall (CC-985)', () => {
  const day1 = new Date(2026, 9, 14, 9)
  const day1Later = new Date(2026, 9, 14, 21)
  const day2 = new Date(2026, 9, 15, 9)
  const hoursBefore = (now: Date, h: number): string => new Date(now.getTime() - h * 3_600_000).toISOString()
  const stalled = (over: Partial<Claim> = {}): Claim =>
    claim({
      agentName: 'bd-T-1',
      stalledReason: 'Status: BLOCKED',
      stalledClass: 'failed',
      stalledAt: hoursBefore(day1, 3),
      ...over,
    })
  const at = (now: Date, live?: (name: string | undefined) => boolean) => ({
    now,
    ...(live === undefined ? {} : { live }),
  })
  const eventsAt = (l: Ledger, opts: ReturnType<typeof at>): SeatEvent[] =>
    seatEvents(l, l, [], {}, opts).alpha ?? []
  const detailOf = (events: SeatEvent[], kind: EventKind): string | undefined =>
    events.find(e => e.kind === kind)?.detail
  /** One tick as the seat sees it: settle, diff, and mark whatever was due as delivered. */
  const tick = (l: Ledger, now: Date): { sent: SeatEvent[]; ledger: Ledger } => {
    const settled = settleNotified(l)
    const sent = eventsAt(settled, at(now))
    return { sent, ledger: markNotified(settled, 'alpha', sent) }
  }
  const agedCount = (sent: SeatEvent[]): number => sent.filter(e => e.kind === 'stall-aged').length

  it('names a lane and task while the agent may run, and the task alone once it is gone', () => {
    const l = ledger(stalled({ stalledAt: hoursBefore(day1, 1) }))

    const gone = detailOf(
      eventsAt(
        l,
        at(day1, () => false),
      ),
      'stalled',
    )
    const running = detailOf(
      eventsAt(
        l,
        at(day1, () => true),
      ),
      'stalled',
    )

    expect(gone).toBe('Status: BLOCKED; holds: task; class failed')
    expect(running).toBe('Status: BLOCKED; holds: lane + task; class failed')
  })

  it('says unclassed for a stall recorded before classes existed', () => {
    const { stalledClass: _cls, ...legacy } = stalled({ stalledAt: hoursBefore(day1, 1) })

    expect(detailOf(eventsAt(ledger(legacy), at(day1)), 'stalled')).toContain('class unclassed')
  })

  it('does not re-arm a told stall whose detail now carries the hold', () => {
    const fresh = stalled({ stalledAt: hoursBefore(day1, 1) })
    const marked = markNotified(ledger(fresh), 'alpha', [{ kind: 'stalled', taskId: 'T-1', detail: 'old' }])
    const { notified: _told, ...reopened } = marked.claims[0]!

    expect(
      eventsAt(
        ledger(reopened),
        at(day1, () => false),
      ),
    ).toEqual([])
  })

  it('names a stall over two hours old once, with its hold and release command', () => {
    const sent = eventsAt(
      ledger(stalled({ notified: ['stalled'] })),
      at(day1, () => false),
    )

    expect(sent).toEqual([
      {
        kind: 'stall-aged',
        taskId: 'T-1',
        day: localDate(day1),
        detail: 'stalled 3h, holds: task, class failed; release: agent-chat burndown release T-1',
      },
    ])
  })

  it('carries the stale proposal and the slice in the aged line', () => {
    const stale = { class: 'blocked' as const, proposed: 'answer or release', since: hoursBefore(day1, 2) }
    const l = ledger(stalled({ slice: 'a', stale, notified: ['stalled', 'stale'] }))

    expect(detailOf(eventsAt(l, at(day1)), 'stall-aged')).toBe(
      'stalled 3h, holds: task, class failed; blocked: answer or release; ' +
        'release: agent-chat burndown release T-1 --slice a',
    )
  })

  it('does not name a stall under two hours old as aged', () => {
    const l = ledger(stalled({ stalledAt: hoursBefore(day1, 1), notified: ['stalled'] }))

    expect(eventsAt(l, at(day1))).toEqual([])
  })

  it('ages a stall from its phase change when it predates stalledAt', () => {
    const { stalledAt: _at, ...legacy } = stalled({ phaseAt: hoursBefore(day1, 5), notified: ['stalled'] })

    expect(detailOf(eventsAt(ledger(legacy), at(day1)), 'stall-aged')).toMatch(/^stalled 5h,/)
  })

  it('names an aged stall once per local day and keeps one day key', () => {
    const first = tick(ledger(stalled({ notified: ['stalled'] })), day1)
    const sameDay = tick(first.ledger, day1Later)
    const nextDay = tick(sameDay.ledger, day2)

    expect([agedCount(first.sent), agedCount(sameDay.sent), agedCount(nextDay.sent)]).toEqual([1, 0, 1])
    expect(nextDay.ledger.claims[0]?.notified).toEqual(['stalled', `stall-aged@${localDate(day2)}`])
  })

  it('stops naming a stall once it is unstalled, and drops its day key', () => {
    const told = tick(ledger(stalled({ notified: ['stalled'] })), day1).ledger
    const { stalledReason: _r, ...unstalled } = told.claims[0]!

    const next = tick(ledger(unstalled), day2)

    expect(next.sent).toEqual([])
    expect(next.ledger.claims[0]?.notified).toBeUndefined()
  })

  it('names nothing for a released claim', () => {
    const before = ledger(stalled({ notified: ['stalled'] }))

    expect(seatEvents(before, ledger(), [], {}, at(day2)).alpha).toBeUndefined()
  })

  it('counts aged stalls past the message budget by kind', () => {
    const many = Array.from({ length: 30 }, (_, i) => stalled({ taskId: `T-${i}`, notified: ['stalled'] }))
    const sent = eventsAt(ledger(...many), at(day1))

    const last = renderSeatEvents('alpha', sent, day1).split('\n').at(-1)

    expect(agedCount(sent)).toBe(30)
    expect(last).toMatch(/^and \d+ more: \d+ stall-aged; run burndown status for them$/)
  })
})
