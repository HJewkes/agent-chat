import { describe, expect, it } from 'vitest'
import { parseReport, parseSlices, readSlices } from '../agents/burndown/report.js'

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
      '[{ "n": "a", "title": "ledger", "points": 2, "doneWhen": "ledger test passes", "owns": ["src/a.ts"] },',
      ' { "n": "b", "title": "tick", "points": 1, "doneWhen": "tick test passes", "dependsOn": ["a"], "owns": ["src/b.ts"] }]',
      '```',
    ].join('\n')

    expect(parseSlices(plan)).toEqual([
      { n: 'a', title: 'ledger', points: 2, doneWhen: 'ledger test passes', dependsOn: [], owns: ['src/a.ts'] },
      { n: 'b', title: 'tick', points: 1, doneWhen: 'tick test passes', dependsOn: ['a'], owns: ['src/b.ts'] },
    ])
  })

  it.each([
    ['no block', '# Plan\nno slices here', 'plan has no burndown-slices block'],
    ['broken JSON', '```burndown-slices\n[{ "n": \n```', 'burndown-slices block is not JSON'],
    ['an empty list', '```burndown-slices\n[]\n```', 'burndown-slices block:'],
  ])('refuses a plan with %s, saying so', (_, plan, reason) => {
    const read = readSlices(plan)

    expect(read.slices).toBeUndefined()
    expect(read.problems).toEqual([expect.stringContaining(reason)])
  })
})

describe('burndown lints planner slices (CC-631)', () => {
  const good = { n: 'a', title: 'x', points: 2, doneWhen: 'a test passes', dependsOn: [], owns: ['src/a.ts'] }
  const planOf = (...slices: object[]): string => `\`\`\`burndown-slices\n${JSON.stringify(slices)}\n\`\`\``

  it('fails a slice over 3 points with one reason naming it', () => {
    expect(readSlices(planOf({ ...good, points: 5 })).problems).toEqual([
      'slice a: 5 points, over the 3-point limit',
    ])
  })

  it('fails a slice that owns no files', () => {
    expect(readSlices(planOf({ ...good, owns: [] })).problems).toEqual(['slice a: owns no files'])
  })

  it('fails a slice that depends on an unknown slice', () => {
    expect(readSlices(planOf({ ...good, dependsOn: ['z'] })).problems).toEqual([
      'slice a: depends on unknown slice z',
    ])
  })

  it('fails a slice with no points or no doneWhen', () => {
    const { points: _p, doneWhen: _d, ...bare } = good

    expect(readSlices(planOf(bare)).problems).toEqual(['slice a: no points', 'slice a: no doneWhen'])
  })

  it('fails a dependency cycle once, and duplicate slice names', () => {
    const plan = planOf(
      { ...good, dependsOn: ['b'] },
      { ...good, n: 'b', dependsOn: ['a'] },
      { ...good, n: 'c' },
      { ...good, n: 'c' },
    )

    expect(readSlices(plan).problems).toEqual([
      'slice c: n is used by more than one slice',
      'slice a: dependency cycle a -> b -> a',
    ])
  })

  it('gives one line per failing slice and rule across slices', () => {
    const plan = planOf({ ...good, points: 4, owns: [] }, { ...good, n: 'b', dependsOn: ['q'] })

    expect(readSlices(plan).problems).toEqual([
      'slice a: 4 points, over the 3-point limit',
      'slice a: owns no files',
      'slice b: depends on unknown slice q',
    ])
  })
})
