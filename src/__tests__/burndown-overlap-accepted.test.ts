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

/** CC-1303: the same waiver for a dispatched ledger slice's owns, named by task and slice or by its PR. */
describe('ledger-owns gate with a planner-accepted overlap', () => {
  const HELD = { holder: 'TP-9 slice b', repo: TITAN, owns: [INDEX], taskId: 'TP-9', slice: 'b' }
  const ACCEPT_TP9_B: AcceptedOverlap = { task: 'TP-9', slice: 'b', path: INDEX, why: 'line 3 only' }
  const REFUSED = { kind: 'file-overlap', reason: `${INDEX} is under TP-9 slice b's owns` }

  // Mutation caught: liveOverlap comparing work.owns without the acceptedHeld filter.
  it("dispatches when the slice accepts the held slice's owned file", () => {
    expect(collision(work([ACCEPT_TP9_B]), facts({}, { heldOwns: [HELD] }))).toBeUndefined()
  })

  it('dispatches when the accept names the held slice by its PR', () => {
    const heldOwns = [{ ...HELD, pr: 1083 }]

    expect(collision(work([ACCEPT_1083]), facts({}, { heldOwns }))).toBeUndefined()
  })

  it('refuses the same overlap when the plan does not declare it', () => {
    expect(collision(work(), facts({}, { heldOwns: [HELD] }))).toEqual(REFUSED)
  })

  it('refuses when the accept names another slice of the same task', () => {
    const other: AcceptedOverlap = { ...ACCEPT_TP9_B, slice: 'c' }

    expect(collision(work([other]), facts({}, { heldOwns: [HELD] }))).toEqual(REFUSED)
  })

  it('refuses when the held slice also owns another owned file', () => {
    const heldOwns = [{ ...HELD, owns: [INDEX, CONDITIONS] }]

    expect(collision(work([ACCEPT_TP9_B]), facts({}, { heldOwns }))).toEqual({
      kind: 'file-overlap',
      reason: `${CONDITIONS} is under TP-9 slice b's owns`,
    })
  })
})
