import { describe, expect, it } from 'vitest'
import { stopLineRefusal, wipLimitFor, wipRefusal, type LineStop } from '../agents/burndown/flow-gate.js'

/** CC-629 S1: the pure downstream WIP and stop-the-line gates. */

const IMPLEMENTER = { tags: [], planner: false }
const EXPEDITE = { tags: ['cos:expedite'], planner: false }
const PLANNER = { tags: [], planner: true }
const STOP: LineStop = { previous: 'stale pid', current: 'crash loop', message: 'serve restarted 3 times' }
const at = (count: number) => ({ name: 'acme/widgets', count, limit: 2, setting: 'wip_limit' })

describe('wipLimitFor', () => {
  it('is twice the reviewer cap', () => {
    expect(wipLimitFor(3).limit).toBe(6)
  })

  it('is at least 2 when the seat reviews nothing itself', () => {
    expect(wipLimitFor(0).limit).toBe(2)
  })

  it('takes a wip_limit override', () => {
    expect(wipLimitFor(3, 1)).toEqual({ limit: 1, setting: 'wip_limit' })
  })
})

describe('wipRefusal', () => {
  it('refuses at the limit and names the count, limit and setting', () => {
    expect(wipRefusal(IMPLEMENTER, '/tmp/w', at(2))).toEqual({
      kind: 'wip',
      reason: 'acme/widgets has 2 PRs in review or waiting, at its WIP limit of 2 (wip_limit)',
    })
  })

  it('passes below the limit', () => {
    expect(wipRefusal(IMPLEMENTER, '/tmp/w', at(1))).toBeUndefined()
  })

  it('fails closed on an unknown count', () => {
    expect(wipRefusal(IMPLEMENTER, '/tmp/w', { unknown: 'could not read Shepherd status' })).toEqual({
      kind: 'wip',
      reason: 'could not read Shepherd status, so downstream WIP for /tmp/w is unknown',
    })
  })

  it('exempts expedite and planners, and an absent count', () => {
    expect(wipRefusal(EXPEDITE, '/tmp/w', at(5))).toBeUndefined()
    expect(wipRefusal(PLANNER, '/tmp/w', { unknown: 'x' })).toBeUndefined()
    expect(wipRefusal(IMPLEMENTER, '/tmp/w', undefined)).toBeUndefined()
  })
})

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
