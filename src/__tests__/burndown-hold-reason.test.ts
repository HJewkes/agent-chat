import { describe, expect, it } from 'vitest'
import { holdReasonRefusal } from '../agents/burndown/hold-reason.js'

describe('Shepherd’s hold reason check, as the tick mirrors it (CC-931)', () => {
  it('refuses a reason whose text before the first ":" is not a charter §8 class', () => {
    expect(holdReasonRefusal('burndown: sensitive word "gate" in T-1')).toBe('"burndown" is not a hold class')
  })

  it('refuses a reason with no class at all', () => {
    expect(holdReasonRefusal('sensitive word')).toBe('"sensitive word" is not a hold class')
  })

  it('accepts a g10-review reason, which needs no task ID', () => {
    expect(holdReasonRefusal('g10-review: sensitive word "gate"; T-1')).toBeUndefined()
    expect(holdReasonRefusal('g10-review: sensitive word "gate"')).toBeUndefined()
  })

  it('refuses a defect class that names no task, and accepts it with one', () => {
    expect(holdReasonRefusal('stalled: no progress')).toBe('a stalled hold names no task ID')
    expect(holdReasonRefusal('stalled: no progress; CC-931')).toBeUndefined()
  })
})
