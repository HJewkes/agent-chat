import { describe, expect, it } from 'vitest'
import { readSlices, type AcceptedOverlap, type PlannedSlice } from '../agents/burndown/report.js'
import { lintSlices } from '../agents/burndown/slice-lint.js'

const INDEX = 'packages/authority/src/index.ts'

const slice = (overlapsAccepted: AcceptedOverlap[]): PlannedSlice => ({
  n: 'a',
  title: 'x',
  points: 2,
  doneWhen: 'edits line 3',
  dependsOn: [],
  owns: [INDEX],
  overlapsAccepted,
})

const planWith = (s: PlannedSlice): string => `\`\`\`burndown-slices\n${JSON.stringify([s])}\n\`\`\`\n`

describe('slice lint on overlapsAccepted (CC-1259)', () => {
  it('passes an entry naming an exact owns path with a reason', () => {
    expect(lintSlices([slice([{ pr: 1083, path: INDEX, why: 'line 3 only' }])])).toEqual([])
  })

  it('fails an entry whose path is not an exact owns entry', () => {
    const reasons = lintSlices([slice([{ pr: 1083, path: 'packages/authority/src/other.ts', why: 'x' }])])

    expect(reasons).toEqual([
      'slice a: overlapsAccepted #1083 path packages/authority/src/other.ts is not an exact owns entry',
    ])
  })

  it('fails a glob path even when owns holds the same glob', () => {
    const glob = 'packages/authority/**'
    const reasons = lintSlices([{ ...slice([{ pr: 1083, path: glob, why: 'x' }]), owns: [glob] }])

    expect(reasons).toEqual([
      `slice a: overlapsAccepted #1083 path ${glob} is a glob; name one exact owns path`,
    ])
  })

  it('rejects an empty why at the schema', () => {
    const read = readSlices(planWith(slice([{ pr: 1083, path: INDEX, why: '  ' }])))

    expect(read.problems).toHaveLength(1)
    expect(read.problems?.[0]).toContain('0.overlapsAccepted.0.why')
  })

  it('carries a valid entry through readSlices', () => {
    const entry = { pr: 1083, path: INDEX, why: 'line 3 only' }

    expect(readSlices(planWith(slice([entry]))).slices?.[0]?.overlapsAccepted).toEqual([entry])
  })
})
