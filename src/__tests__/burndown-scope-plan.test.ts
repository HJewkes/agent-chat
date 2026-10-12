import { describe, expect, it } from 'vitest'
import { parseSeat } from '../agents/burndown/policy.js'
import { planSectionIds, scopeRefusal, seatScopeOf, type SeatScope } from '../agents/burndown/seat-scope.js'

const scope: SeatScope = { tags: ['factory'], shared: ['alpha'], backlog: new Set(), plan: new Set(['CC-1']) }
const refusal = (id: string, tags: string[], of: SeatScope = scope) => scopeRefusal(of, 'alpha', { id, tags })

const PLAN = [
  '# Plan',
  '## 1. Context',
  'Mentions CC-9 before the order.',
  '## 2. Priority order',
  '| P1 | CC-1, TP-2 |',
  'Progress: TD-3 merged.',
  '## 3. Milestones',
  'CC-4 is later.',
].join('\n')

describe('plan section 2 ids pass the seat scope filter (CC-1128)', () => {
  it('passes a plan id that carries no scope tag', () => {
    expect(refusal('CC-1', [])).toBeUndefined()
  })

  it('passes a task linked to a plan id by parent: or dep:', () => {
    expect(refusal('CC-7', ['parent:CC-1'])).toBeUndefined()
    expect(refusal('CC-8', ['dep:CC-1'])).toBeUndefined()
    expect(refusal('CC-8', ['delivered-by:CC-1'])).toBeUndefined()
    expect(refusal('CC-8', ['blocked-by:CC-1'])).toBeUndefined()
  })

  it('still refuses an untagged id the plan does not name', () => {
    expect(refusal('CC-2', [])).toMatch(/none of scope_tags/)
  })

  it('refuses an id that only extends a plan id', () => {
    expect(refusal('CC-11', [])).toMatch(/none of scope_tags/)
    expect(refusal('CC-1128', [])).toMatch(/none of scope_tags/)
  })

  it('refuses a link tag naming an id that only extends a plan id', () => {
    for (const link of ['dep:', 'parent:', 'delivered-by:', 'blocked-by:']) {
      expect(refusal('CC-2', [`${link}CC-11`])).toMatch(/none of scope_tags/)
    }
  })

  it('refuses a task whose only plan mention is under a non-link prefix', () => {
    expect(refusal('CC-2', ['milestone:CC-1'])).toMatch(/none of scope_tags/)
  })

  it('refuses an untagged id when the plan set is empty or absent', () => {
    expect(refusal('CC-1', [], { ...scope, plan: new Set() })).toMatch(/none of scope_tags/)
    const { plan: _plan, ...noPlan } = scope
    expect(refusal('CC-1', [], noPlan)).toMatch(/none of scope_tags/)
  })

  it('reads ids from section 2 only, and nothing without a section 2', () => {
    expect(planSectionIds(PLAN)).toEqual(new Set(['CC-1', 'TP-2', 'TD-3']))
    expect(planSectionIds('# Plan\n## 1. Context\nCC-1\n## 3. Later\nCC-2')).toBeUndefined()
  })

  it('does not take ## 20. or ### 2. for section 2', () => {
    expect(planSectionIds('## 20. Later\nCC-1')).toBeUndefined()
    expect(planSectionIds('### 2. Sub\nCC-2')).toBeUndefined()
  })

  it('parses plan_file in the seat file and copies it into the scope with the plan set', () => {
    const seats = {
      a: parseSeat('---\ninitiatives: {alpha: 1}\nscope_tags: [factory]\nplan_file: ../x.md\n---\n', 'a'),
      b: parseSeat('---\ninitiatives: {alpha: 1}\n---\n', 'b'),
    }
    const plan = new Set(['CC-1'])

    const built = seatScopeOf(seats, 'a', new Set(), undefined, plan)

    expect(seats.a.plan_file).toBe('../x.md')
    expect(built.planFile).toBe('../x.md')
    expect(built.plan).toBe(plan)
    expect(scopeRefusal(built, 'alpha', { id: 'CC-1', tags: [] })).toBeUndefined()
  })
})
