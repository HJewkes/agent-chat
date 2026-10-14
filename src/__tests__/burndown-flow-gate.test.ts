import { describe, expect, it } from 'vitest'
import { reviewBackpressureRefusal, stopLineRefusal, type LineStop } from '../agents/burndown/flow-gate.js'

/** CC-629 S1: the pure stop-the-line gate. */

const IMPLEMENTER = { tags: [], planner: false }
const EXPEDITE = { tags: ['cos:expedite'], planner: false }
const PLANNER = { tags: [], planner: true }
const STOP: LineStop = { previous: 'stale pid', current: 'crash loop', message: 'serve restarted 3 times' }

describe('stopLineRefusal', () => {
  it('refuses with both causes and the message', () => {
    expect(stopLineRefusal(IMPLEMENTER, STOP)).toEqual({
      kind: 'stop-line',
      reason:
        'service check failed twice (stale pid, then crash loop): serve restarted 3 times; only cos:expedite dispatches',
    })
  })

  it('exempts expedite and planners, and runs with no stop', () => {
    expect(stopLineRefusal(EXPEDITE, STOP)).toBeUndefined()
    expect(stopLineRefusal(PLANNER, STOP)).toBeUndefined()
    expect(stopLineRefusal(IMPLEMENTER, undefined)).toBeUndefined()
  })
})

/** CC-1106: review backpressure against k x Shepherd's review cap. */
describe('reviewBackpressureRefusal', () => {
  const backlog = (queued: number) => ({ queued, waiting: queued + 2, running: 2, cap: 16 })
  const ON = { mode: 'on', k: 2 } as const

  it('refuses an implementer at 33 queued over 2 x cap 16, with the lever and its reading', () => {
    expect(reviewBackpressureRefusal(IMPLEMENTER, backlog(33), ON)).toEqual({
      kind: 'review-backpressure',
      reason: '33 reviews queued (35 waiting, 2 running) above 2 x cap 16',
      gate: {
        lever: 'burndown.reviewBackpressure.k',
        value: 32,
        reading: 33,
        headroom: -1,
        source: 'shepherd status reviewSlots',
      },
    })
  })

  it('lets an implementer through at 32 queued', () => {
    expect(reviewBackpressureRefusal(IMPLEMENTER, backlog(32), ON)).toBeUndefined()
  })

  it('exempts planners and cos:expedite', () => {
    expect(reviewBackpressureRefusal(PLANNER, backlog(40), ON)).toBeUndefined()
    expect(reviewBackpressureRefusal(EXPEDITE, backlog(40), ON)).toBeUndefined()
  })

  it('notes a would-refuse in shadow and does nothing when off or unconfigured', () => {
    expect(reviewBackpressureRefusal(IMPLEMENTER, backlog(33), { mode: 'shadow', k: 2 })).toEqual({
      note: 'would-refuse review-backpressure: 33 reviews queued (35 waiting, 2 running) above 2 x cap 16',
    })
    expect(reviewBackpressureRefusal(IMPLEMENTER, backlog(33), { mode: 'off', k: 2 })).toBeUndefined()
    expect(reviewBackpressureRefusal(IMPLEMENTER, backlog(33), undefined)).toBeUndefined()
  })

  it('fails open on an unread backlog with a note', () => {
    expect(reviewBackpressureRefusal(IMPLEMENTER, { unknown: 'no reviewSlots' }, ON)).toEqual({
      note: 'review backpressure unread, implementers dispatch: no reviewSlots',
    })
  })
})
