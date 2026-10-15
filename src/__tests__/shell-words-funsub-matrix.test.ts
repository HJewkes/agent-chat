import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { expansionRisk, parseShell } from '../leak-guard/shell-words.js'

// What bash 5.3.9 did with every three tokens before a `}` in a funsub: N ran the push inside it, - ran
// nothing. Recorded by scripts/record-funsub-matrix.mjs, so CI needs no bash 5.3 (CC-1327).
interface Matrix {
  bash: string
  openers: string[]
  tokens: string[]
  results: string
}
const matrix = JSON.parse(
  readFileSync(new URL('fixtures/funsub-token-matrix.json', import.meta.url), 'utf8'),
) as Matrix

const lines = matrix.openers.flatMap(open =>
  matrix.tokens.flatMap(a =>
    matrix.tokens.flatMap(b =>
      matrix.tokens.map(c => `echo "${open}${a} ${b} ${c} }; git push --no-verify; }"`),
    ),
  ),
)

/** The reader sees the push, or fails closed on the line. */
const caught = (src: string): boolean =>
  expansionRisk(src) === 'unreadable' || parseShell(src).some(cmd => cmd.words[0] === 'git')

describe('three tokens before a funsub } against recorded bash 5.3.9', () => {
  it('covers every opener and token triple', () => {
    expect(matrix.bash).toMatch(/^5\.3\./)
    expect(matrix.results).toHaveLength(lines.length)
    expect(lines).toHaveLength(2 * matrix.tokens.length ** 3)
  })

  it('sees every push bash runs, or fails closed', () => {
    const missed = lines.filter((src, i) => matrix.results[i] === 'N' && !caught(src))

    expect(missed).toEqual([])
  })
})
