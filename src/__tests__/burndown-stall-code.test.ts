import { describe, expect, it } from 'vitest'
import { LADDER_CODES, STALL_CODES, firstCode, parkUpdate } from '../agents/burndown/stall-code.js'

describe('stall code precedence', () => {
  it('picks the earlier code when several hold', () => {
    expect(firstCode(['no-progress', 'dirty-uncommitted', 'lease-expired'])).toBe('dirty-uncommitted')
  })

  it('ranks each code above every code after it, whatever the input order', () => {
    const winners = STALL_CODES.map((_, i) => firstCode([...STALL_CODES.slice(i)].reverse()))

    expect(winners).toEqual(STALL_CODES)
  })

  it('gives no code when none holds', () => {
    expect(firstCode([])).toBeUndefined()
  })

  it('leaves the owner-only codes off the ladder, retry-spent among them', () => {
    expect(STALL_CODES.filter(code => !LADDER_CODES.includes(code))).toEqual([
      'shepherd-ended',
      'planner-refused',
      'retry-spent',
    ])
    expect(firstCode(['no-progress', 'retry-spent'])).toBe('retry-spent')
  })

  it('builds the park update with the class of its code', () => {
    expect(parkUpdate({ taskId: 'T-1', slice: 's2' }, 'retry-spent', 'refused 3/3')).toEqual({
      kind: 'update',
      key: { taskId: 'T-1', slice: 's2' },
      patch: { stalledReason: 'retry-spent: refused 3/3', stalledClass: 'failed', stallCode: 'retry-spent' },
    })
  })
})
