import { describe, expect, it } from 'vitest'
import { retireThresholdK } from '../config.js'
import { contextKOf, retireCell, retireDue, reportTargets } from '../agents/retire-due.js'
import type { BudgetRead } from '../agents/budget.js'

const reading = (profile: string, contextK: number | null) => ({
  contextK,
  retireK: retireThresholdK(profile) ?? null,
})

describe('agent ls retire-due by role', () => {
  it('an implementer at 210k that has reported is due', () => {
    expect(retireDue(reading('bd-implementer', 210), true)).toBe(true)
  })

  it('a reviewer at 290k is not due and at 310k is', () => {
    expect(retireDue(reading('bd-reviewer', 290), true)).toBe(false)
    expect(retireDue(reading('bd-reviewer', 310), true)).toBe(true)
  })

  it('a planner at 260k that has reported is due', () => {
    expect(retireDue(reading('bd-planner', 260), true)).toBe(true)
  })

  it('an agent past its threshold that has not reported is not due', () => {
    expect(retireDue(reading('bd-implementer', 260), false)).toBe(false)
  })

  it('an agent without a budget reading is not due and shows no cell', () => {
    const r = reading('bd-implementer', null)
    expect(retireDue(r, true)).toBe(false)
    expect(retireCell(r, false)).toBe('')
  })

  it('a profile naming no role shows its fill without a threshold and is never due', () => {
    const r = reading('coordinator', 400)
    expect(retireDue(r, true)).toBe(false)
    expect(retireCell(r, false)).toBe('ctx=400k')
  })
})

describe('the agent ls retire cell', () => {
  it('shows fill against threshold and marks a due agent', () => {
    expect(retireCell({ contextK: 212, retireK: 200 }, true)).toBe('ctx=212k/200k retire-due')
    expect(retireCell({ contextK: 150, retireK: 200 }, false)).toBe('ctx=150k/200k')
  })

  it('reads thousands of tokens from a budget and null from a miss', () => {
    const found = {
      found: true,
      path: 'p',
      age_seconds: 1,
      stale: false,
      budget: {
        session_id: 's',
        written_at: 0,
        context: { input_tokens: 212_400, exceeds_200k: true },
        cost: {},
        rate_limits: {},
      },
    } as unknown as BudgetRead
    expect(contextKOf(found)).toBe(212)
    expect(contextKOf({ found: false, path: 'p', reason: 'no_file' } as BudgetRead)).toBeNull()
  })
})

describe('who an agent reports to', () => {
  it('a human-spawned agent counts a report to the human or to the tick reportTo', () => {
    expect(reportTargets('human', 'tick-lead')).toEqual(['human', 'tick-lead'])
  })

  it('a seat-spawned agent counts only a report to its spawner', () => {
    expect(reportTargets('seat-a', 'tick-lead')).toEqual(['seat-a'])
  })

  it('a human-spawned agent with no reportTo counts only the human', () => {
    expect(reportTargets('human', undefined)).toEqual(['human'])
  })
})
