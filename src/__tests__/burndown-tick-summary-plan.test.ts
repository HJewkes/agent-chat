import { describe, expect, it } from 'vitest'
import type { Refusal, Task } from '../agents/burndown/eligibility.js'
import type { SeatOutcome } from '../agents/burndown/no-dispatch.js'
import { tickSummary, type SummaryInputs } from '../agents/burndown/tick-summary.js'

/** CC-1128 c: the tick row counts refusals of tasks the seat's plan_file section 2 names, per refusal kind. */

const task = (id: string, ...tags: string[]): Task => ({ id, title: id, tags })

const refusal = (taskId: string, kind: Refusal['kind']): Refusal => ({
  initiative: 'demo',
  task: taskId,
  kind,
  reason: 'r',
})

const REFUSALS: Refusal[] = [
  refusal('A-1', 'claimed'),
  refusal('A-3', 'claimed'),
  refusal('A-2', 'no-brief'),
  refusal('A-4', 'claimed'),
  { initiative: '-', kind: 'plan-blocked', reason: 'backlog unreadable' },
]

function inputs(outcome: Partial<SeatOutcome>): SummaryInputs {
  return {
    now: new Date(2026, 9, 12, 12, 0),
    maxAgeDays: 14,
    caps: {},
    outcomes: [{ seat: 'seat-p', dispatched: 0, refusals: REFUSALS, ...outcome }],
    dispatch: [],
    tasks: new Map([
      ['demo', [task('A-1'), task('A-2'), task('A-3', 'parent:A-1'), task('A-4', 'milestone:A-1')]],
    ]),
    registrations: [],
  }
}

describe('tick summary on-plan refusals (CC-1128)', () => {
  it('counts a direct plan id and a parent-linked task, leaving the refusal counts unchanged', () => {
    const seat = tickSummary(inputs({ plan: new Set(['A-1']) })).seats['seat-p']

    expect(seat?.onPlanRefusals).toEqual({ claimed: 2 })
    expect(seat?.refusals).toEqual({ claimed: 3, 'no-brief': 1, 'plan-blocked': 1 })
  })

  it('emits an empty count when the plan names none of the refused tasks', () => {
    const seat = tickSummary(inputs({ plan: new Set(['Z-9']) })).seats['seat-p']

    expect(seat?.onPlanRefusals).toEqual({})
  })

  it('has no onPlanRefusals key for a seat without a plan', () => {
    const seat = tickSummary(inputs({})).seats['seat-p']

    expect(seat).not.toHaveProperty('onPlanRefusals')
  })
})
