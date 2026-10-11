import { describe, expect, it } from 'vitest'
import { stopLineRefusal, type LineStop } from '../agents/burndown/flow-gate.js'

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
