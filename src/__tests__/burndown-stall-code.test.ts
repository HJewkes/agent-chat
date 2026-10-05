import { describe, expect, it } from 'vitest'
import { LADDER_CODES, STALL_CODES, firstCode } from '../agents/burndown/stall-code.js'

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

  it('leaves the two owner-only codes off the ladder', () => {
    expect(STALL_CODES.filter(code => !LADDER_CODES.includes(code))).toEqual([
      'shepherd-ended',
      'planner-refused',
    ])
  })
})
