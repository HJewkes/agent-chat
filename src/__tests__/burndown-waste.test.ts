import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ceremonyAmplification,
  redundantWake,
  reviewCarousel,
  WASTE_THRESHOLDS,
  type LineageObservation,
  type VerdictObservation,
} from '../agents/burndown/waste.js'

const H1 = 'a'.repeat(40)
const H2 = 'b'.repeat(40)
const verdicts = (
  n: number,
  head: string,
  verdict: 'MERGE' | 'FIX_FIRST' = 'FIX_FIRST',
  pr = 'o/r#1',
): VerdictObservation[] => Array.from({ length: n }, () => ({ task: 'T-1', pr, head, verdict }))
const lineage = (transitions: number, mergedPrs: number, hasImplementerRun = true): LineageObservation => ({
  task: 'T-1',
  transitions,
  mergedPrs,
  hasImplementerRun,
})
const wakes = (rescued: boolean[]) => rescued.map(r => ({ task: 'T-1', agent: 'a', rescued: r }))

describe('WASTE_THRESHOLDS', () => {
  it('carries openrig defaults', () => {
    expect(WASTE_THRESHOLDS).toEqual({
      ceremonyTransitions: 20,
      ceremonyRatio: 12,
      reviewReturns: 4,
      redundantWakes: 4,
    })
  })
})

describe('reviewCarousel', () => {
  it('five FIX_FIRSTs at one head on one PR give a review carousel', () => {
    const found = reviewCarousel(verdicts(5, H1))
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      detector: 'review-carousel',
      pr: 'o/r#1',
      head: H1,
      counts: { returns: 5 },
    })
  })

  it('three FIX_FIRSTs then a new head with two more give no carousel', () => {
    expect(reviewCarousel([...verdicts(3, H1), ...verdicts(2, H2)])).toEqual([])
  })

  it('four FIX_FIRSTs at one head fire and three do not', () => {
    expect(reviewCarousel(verdicts(4, H1))).toHaveLength(1)
    expect(reviewCarousel(verdicts(3, H1))).toEqual([])
  })

  it('MERGE verdicts at the same head do not count as returns', () => {
    expect(reviewCarousel([...verdicts(3, H1), ...verdicts(2, H1, 'MERGE')])).toEqual([])
  })

  it('the same head on two PRs is two groups', () => {
    expect(reviewCarousel([...verdicts(2, H1), ...verdicts(2, H1, 'FIX_FIRST', 'o/r#2')])).toEqual([])
  })
})

describe('ceremonyAmplification', () => {
  it('ceremony fires at 20 transitions and one merged PR, not at 19', () => {
    const found = ceremonyAmplification([lineage(20, 1)])
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ status: 'active', counts: { ratio: 20 } })
    expect(ceremonyAmplification([lineage(19, 1)])).toEqual([])
  })

  it('ceremony needs the ratio as well as the count', () => {
    expect(ceremonyAmplification([lineage(24, 2)])).toHaveLength(1)
    expect(ceremonyAmplification([lineage(24, 3)])).toEqual([])
  })

  it('zero merged PRs divide by one', () => {
    expect(ceremonyAmplification([lineage(20, 0)])[0]?.counts.ratio).toBe(20)
  })

  it('a planning-only lineage is indeterminate, never fired', () => {
    const found = ceremonyAmplification([lineage(30, 0, false)])
    expect(found).toHaveLength(1)
    expect(found[0]?.status).toBe('indeterminate')
    expect(found[0]?.counts).not.toHaveProperty('ratio')
  })
})

describe('redundantWake', () => {
  it('redundant wakes count only wakes with no reply', () => {
    const six = wakes([true, true, false, false, false, false])
    expect(redundantWake(six)).toMatchObject([{ detector: 'redundant-wake', counts: { redundant: 4 } }])
    expect(redundantWake(wakes([true, true, false, false, false]))).toEqual([])
  })
})

describe('license', () => {
  const dir = new URL('../agents/burndown/', import.meta.url)
  it("the ported file keeps openrig's license", () => {
    const header = readFileSync(new URL('waste.ts', dir), 'utf8').split('*/')[0]
    expect(header).toContain('Apache-2.0')
    expect(header).toContain('openrig')
    expect(header).toContain('LICENSE.openrig')
    const text = readFileSync(new URL('LICENSE.openrig', dir), 'utf8')
    expect(text).toContain('Apache License')
    expect(text).toContain('Version 2.0, January 2004')
  })
})
