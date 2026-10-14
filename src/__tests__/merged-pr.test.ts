import { describe, expect, it } from 'vitest'
import { parseMergedPrs } from '../agents/isolation/merged-pr.js'

describe("reading gh's merged PRs for a head branch (CC-1064)", () => {
  it("takes each PR's head commit from headRefOid", () => {
    const stdout = JSON.stringify([
      { number: 929, headRefOid: 'a'.repeat(40), mergedAt: '2026-10-14T10:28:36Z' },
    ])

    expect(parseMergedPrs(stdout)).toEqual([{ number: 929, headSha: 'a'.repeat(40) }])
  })

  it('reads an empty list as no merged PR', () => {
    expect(parseMergedPrs('[]')).toEqual([])
  })

  it('throws on an answer that is not a JSON array', () => {
    expect(() => parseMergedPrs('{"number":1}')).toThrow(/JSON array/)
  })

  it('throws on a PR without a head commit rather than trusting it', () => {
    expect(() => parseMergedPrs('[{"number":1}]')).toThrow(/headRefOid/)
  })
})
