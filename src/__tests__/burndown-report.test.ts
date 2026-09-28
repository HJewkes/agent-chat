import { describe, expect, it } from 'vitest'
import { parseReport, parseSlices } from '../agents/burndown/report.js'

describe('burndown report parser', () => {
  it('reads the status, PR and plan path from a worker or planner report', () => {
    const report = parseReport(
      '\n**Status: DONE_WITH_CONCERNS**\nPR: https://github.com/o/r/pull/9\nPlan: /aw/cc/sources/CC-1-plan.md\n',
    )

    expect(report).toEqual(
      expect.objectContaining({
        status: 'DONE_WITH_CONCERNS',
        pr: 'https://github.com/o/r/pull/9',
        plan: '/aw/cc/sources/CC-1-plan.md',
      }),
    )
  })

  it('reads a reviewer verdict from the first line', () => {
    expect(parseReport('Verdict: APPROVE\nLooks right.').verdict).toBe('APPROVE')
  })

  it('reads a closing PARKED line as the question id, alongside the Status first line', () => {
    const report = parseReport('Status: NEEDS_CONTEXT\nAsked which schema to keep.\nPARKED 3f9a')

    expect(report).toEqual(expect.objectContaining({ status: 'NEEDS_CONTEXT', parked: '3f9a' }))
  })

  it('reads no question id when PARKED is not the last line', () => {
    expect(parseReport('Status: DONE\nPARKED 3f9a\nPR: https://github.com/o/r/pull/9').parked).toBeUndefined()
  })

  it('yields unknown for a last message it cannot read, never DONE', () => {
    const report = parseReport('I think everything is finished now.')

    expect(report.status).toBe('unknown')
    expect(report.verdict).toBeUndefined()
    expect(report.firstLine).toBe('I think everything is finished now.')
  })

  it('reads a burndown-slices block from a plan file', () => {
    const plan = [
      '# Plan',
      '```burndown-slices',
      '[{ "n": "a", "title": "ledger", "dependsOn": [], "owns": ["src/a.ts"] },',
      ' { "n": "b", "title": "tick", "dependsOn": ["a"] }]',
      '```',
    ].join('\n')

    expect(parseSlices(plan)).toEqual([
      { n: 'a', title: 'ledger', dependsOn: [], owns: ['src/a.ts'] },
      { n: 'b', title: 'tick', dependsOn: ['a'], owns: [] },
    ])
  })

  it.each([
    ['no block', '# Plan\nno slices here'],
    ['broken JSON', '```burndown-slices\n[{ "n": \n```'],
    ['an empty list', '```burndown-slices\n[]\n```'],
    ['an unknown dependency', '```burndown-slices\n[{ "n": "a", "title": "x", "dependsOn": ["z"] }]\n```'],
  ])('refuses a plan with %s', (_, plan) => {
    expect(parseSlices(plan)).toBeUndefined()
  })
})
