import { describe, expect, it } from 'vitest'
import type { PlannedSlice } from '../agents/burndown/report.js'
import { lintSlices, sliceWarnings } from '../agents/burndown/slice-lint.js'

const slice = (extra: Partial<PlannedSlice>): PlannedSlice => ({
  n: 'a',
  title: 'x',
  points: 2,
  doneWhen: 'renders the widget',
  dependsOn: [],
  owns: ['src/x.ts'],
  ...extra,
})

describe('slice lint on publish (CC-987)', () => {
  it('fails a slice that declares publish, naming the split into its own task', () => {
    const reasons = lintSlices([slice({ doneWhen: 'publishes @t/x at 1.0.0', ops: ['publish'] })])

    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('own task')
    expect(reasons[0]).toContain('dep:')
  })

  it('passes a publish mention marked as subject matter with ops [], and does not warn', () => {
    const slices = [slice({ doneWhen: 'publishes the docs site', ops: [] })]

    expect(lintSlices(slices)).toEqual([])
    expect(sliceWarnings(slices)).toEqual([])
  })

  it('warns once on a publish mention with no ops field, without failing', () => {
    const slices = [slice({ doneWhen: 'publishes the docs site' })]

    expect(lintSlices(slices)).toEqual([])
    expect(sliceWarnings(slices)).toEqual([
      `slice a: doneWhen mentions publish ('publishes'); if this slice publishes, move it to its own task; else add "ops": []`,
    ])
  })

  it('is silent on a slice whose doneWhen has no publish mention', () => {
    const slices = [slice({})]

    expect(lintSlices(slices)).toEqual([])
    expect(sliceWarnings(slices)).toEqual([])
  })
})
