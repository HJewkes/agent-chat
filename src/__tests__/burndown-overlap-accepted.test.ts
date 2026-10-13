import { describe, expect, it } from 'vitest'
import {
  collision,
  type CollisionFacts,
  type CollisionWork,
  type OpenPr,
} from '../agents/burndown/collision.js'
import type { AcceptedOverlap } from '../agents/burndown/report.js'

/** CC-1259: a planner-declared overlap with one open PR on one exact path does not refuse dispatch. */

const TITAN = '/x/titan-platform'
const INDEX = 'packages/authority/src/index.ts'
const CONDITIONS = 'packages/authority/src/conditions.ts'
const ACCEPT_1083: AcceptedOverlap = { pr: 1083, path: INDEX, why: 'line 3 only; #1083 appends at :10' }

const pr = (number: number): OpenPr => ({ number, title: 'Other work', branch: `feat/${number}`, body: '' })

const facts = (files: Record<number, string[]>, over: Partial<CollisionFacts> = {}): CollisionFacts => ({
  repo: TITAN,
  subjects: [],
  prs: Object.keys(files).map(n => pr(Number(n))),
  prFiles: n => files[n],
  names: [],
  claims: [],
  ours: new Set(),
  held: [],
  heldOwns: [],
  overlapExempt: [],
  ...over,
})

const work = (overlapsAccepted?: AcceptedOverlap[]): CollisionWork => ({
  taskId: 'TP-2440',
  slice: 'a',
  tags: [],
  owns: [INDEX, CONDITIONS],
  ...(overlapsAccepted === undefined ? {} : { overlapsAccepted }),
})

describe('file-overlap gate with a planner-accepted overlap', () => {
  it("dispatches TP-2440 a's case: index.ts shared with #1083, accepted", () => {
    expect(collision(work([ACCEPT_1083]), facts({ 1083: [INDEX] }))).toBeUndefined()
  })

  it('refuses the same overlap when the plan does not declare it', () => {
    expect(collision(work(), facts({ 1083: [INDEX] }))).toEqual({
      kind: 'file-overlap',
      reason: `#1083 touches ${INDEX}`,
      pr: 1083,
    })
  })

  it('refuses when another PR touches the accepted path', () => {
    expect(collision(work([ACCEPT_1083]), facts({ 1083: [INDEX], 1090: [INDEX] }))).toEqual({
      kind: 'file-overlap',
      reason: `#1090 touches ${INDEX}`,
      pr: 1090,
    })
  })

  it('refuses when the accepted PR also touches another owned file', () => {
    expect(collision(work([ACCEPT_1083]), facts({ 1083: [INDEX, CONDITIONS] }))).toEqual({
      kind: 'file-overlap',
      reason: `#1083 touches ${CONDITIONS}`,
      pr: 1083,
    })
  })

  it("refuses when a held claim's owns include the accepted path", () => {
    const heldOwns = [{ holder: 'TP-9 slice a', repo: TITAN, owns: [INDEX] }]

    expect(collision(work([ACCEPT_1083]), facts({ 1083: [INDEX] }, { heldOwns }))).toEqual({
      kind: 'file-overlap',
      reason: `${INDEX} is under TP-9 slice a's owns`,
    })
  })
})
