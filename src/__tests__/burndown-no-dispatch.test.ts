import { describe, expect, it } from 'vitest'
import type { Refusal } from '../agents/burndown/eligibility.js'
import { dueReasons, noDispatchReason, refusalTally } from '../agents/burndown/no-dispatch.js'

/** CC-859: the pure side of the seat's "dispatched nothing" line. */

const NOW = new Date(2026, 1, 3, 12, 0)
const refused = (kind: Refusal['kind'], reason = 'synthetic'): Refusal => ({
  initiative: 'demo',
  kind,
  reason,
})

describe('the reason line', () => {
  it('counts refusals by kind, most first', () => {
    const refusals = [refused('trust'), refused('out-of-scope'), refused('out-of-scope'), refused('claimed')]

    const reason = noDispatchReason({ seat: 's', dispatched: 0, refusals })

    expect(reason?.text).toBe('burndown: dispatched nothing; refusals out-of-scope 2, claimed 1, trust 1')
  })

  it('names a machine stop before a budget stop or a full cap', () => {
    const refusals = [
      refused('slots', 'slots full'),
      refused('budget', 'pool at 95%'),
      refused('stop-line', 'line down'),
    ]

    expect(noDispatchReason({ seat: 's', dispatched: 0, refusals })?.text).toMatch(
      /; machine stop: line down;/,
    )
  })

  it('names a seat that could not be planned', () => {
    const reason = noDispatchReason({ seat: 's', dispatched: 0, refusals: [], skipped: 'charter unreadable' })

    expect(reason?.text).toBe('burndown: dispatched nothing; seat skipped: charter unreadable')
  })

  it('keys on the reason set, not the readings or counts', () => {
    const one = noDispatchReason({ seat: 's', dispatched: 0, refusals: [refused('budget', 'pool at 91%')] })
    const two = noDispatchReason({
      seat: 's',
      dispatched: 0,
      refusals: [refused('budget', 'pool at 93%'), refused('budget', 'pool at 93%')],
    })

    expect(one?.key).toBe(two?.key)
  })
})

describe('the refusal tally (CC-1186)', () => {
  const of = (initiative: string, task: string | undefined, kind: Refusal['kind']): Refusal => ({
    initiative,
    ...(task === undefined ? {} : { task }),
    kind,
    reason: 'r',
  })

  it('counts a task refused once per slice and once on its row once, under its first kind', () => {
    const refusals = [
      of('demo', 'T', 'file-overlap'),
      of('demo', 'T', 'role-cap'),
      of('demo', 'T', 'claimed'),
      of('demo', 'U', 'plan-blocked'),
      of('-', undefined, 'plan-blocked'),
    ]

    const tally = refusalTally(refusals)

    expect(noDispatchReason({ seat: 's', dispatched: 0, refusals })?.text).toMatch(
      /; refusals plan-blocked 2, file-overlap 1$/,
    )
    expect(tally.reduce((sum, [, n]) => sum + n, 0)).toBe(3)
  })

  it('counts two refusals that name no task twice', () => {
    const refusals = [of('-', undefined, 'plan-blocked'), of('-', undefined, 'plan-blocked')]

    expect(refusalTally(refusals)).toEqual([['plan-blocked', 2]])
  })

  it('counts the same task id in two initiatives twice', () => {
    const refusals = [of('one', 'T-1', 'claimed'), of('two', 'T-1', 'claimed')]

    expect(refusalTally(refusals)).toEqual([['claimed', 2]])
  })

  it("leaves the stop to read every refusal, not only each task's first", () => {
    const refusals = [of('demo', 'T', 'file-overlap'), of('demo', 'T', 'role-cap')]

    expect(noDispatchReason({ seat: 's', dispatched: 0, refusals })?.text).toMatch(/; full cap: r;/)
  })
})

describe('which lines are due', () => {
  const mark = { key: 'full cap slots', at: NOW.toISOString() }
  const states = { s: { samples: [], noDispatch: mark } }

  it('drops the mark of a seat that dispatched, so its next empty tick is due at once', () => {
    const after = dueReasons([{ seat: 's', dispatched: 1, refusals: [] }], states, NOW)

    expect(after).toEqual({ due: [], states: { s: { samples: [] } } })
  })

  it('keeps the mark of a seat whose reasons are unchanged inside the hour', () => {
    const later = new Date(NOW.getTime() + 30 * 60_000)

    const after = dueReasons([{ seat: 's', dispatched: 0, refusals: [refused('slots')] }], states, later)

    expect(after).toEqual({ due: [], states })
  })
})
