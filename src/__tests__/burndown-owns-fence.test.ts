import { describe, expect, it } from 'vitest'
import { outsideOwns } from '../agents/burndown/owns-fence.js'

/** A slice's changed files against its declared owns (CC-669): pure, no git. */

const OWNS = ['src/agents/burndown/collision.ts']

describe('a slice PR against its owns', () => {
  it('reports nothing for a file the slice owns', () => {
    expect(outsideOwns(['src/agents/burndown/collision.ts'], OWNS)).toEqual([])
  })

  it('allows a companion test in src/__tests__ named for the owned file', () => {
    expect(outsideOwns(['src/__tests__/burndown-collision.test.ts'], OWNS)).toEqual([])
  })

  it('allows a test beside the owned file', () => {
    expect(outsideOwns(['src/agents/burndown/collision.test.ts'], OWNS)).toEqual([])
  })

  it('reports a file outside the owns', () => {
    const files = ['src/agents/burndown/collision.ts', 'src/agents/burndown/ledger.ts']

    expect(outsideOwns(files, OWNS)).toEqual(['src/agents/burndown/ledger.ts'])
  })

  it('reports a test that names no owned stem', () => {
    expect(outsideOwns(['src/__tests__/burndown-ledger.test.ts'], OWNS)).toEqual([
      'src/__tests__/burndown-ledger.test.ts',
    ])
  })

  it("allows a test named for a wildcard entry's dir, and reports one named for another", () => {
    const files = ['src/__tests__/burndown-owns-fence.test.ts', 'src/__tests__/seats-owns.test.ts']

    expect(outsideOwns(files, ['src/agents/burndown/*.ts'])).toEqual(['src/__tests__/seats-owns.test.ts'])
  })
})
