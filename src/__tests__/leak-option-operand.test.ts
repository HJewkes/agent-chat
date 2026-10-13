import { describe, expect, it } from 'vitest'
import { operandMaySpellOption } from '../leak-guard/option-operand.js'
import { parseShell } from '../leak-guard/shell-words.js'

const pushedWord = (word: string): string => {
  const marked = parseShell(`git push origin ${word}`)[0]?.marked[3]
  if (marked === undefined) throw new Error(`no fourth word in: ${word}`)
  return marked
}

describe('a ${...} operand that may yield an option word (CC-1286)', () => {
  it.each([
    'main${X:- --no-verify}',
    '${X:---no-verify}',
    '"${X:---no-verify}"',
    '${X- --no-verify}',
    '${X:= -x}',
    '${X=--no-verify}',
    '${X::=--no-verify}',
    '${X:+ --no-verify}',
    '${X+--no-veri}',
    '${X:? --no-verify}',
    '${X? --no-verify}',
    '${=X:- --no-verify}',
    '${^X:- -x}',
    '${arr[1]:- --no-verify}',
    '${X:-ax--no-verify}',
    '${X/#/--no-verify }',
    '${X/%/ --no-verify}',
    '${X//a/--no-verify}',
    '${X/a/-n}',
    '${X:/a/--no-verify}',
    '${X:s./.--no-verify .}',
    '${=X:s./.--no-verify .}',
    '${X:gs/a/--no-verify}',
    '${X:&}',
    '${X:g&}',
    '${X:h:s/a/b}',
    '${X:N}',
    '--push-option=${X:- --no-verify}',
    'main${B}${X:- --no-verify}',
    '${X:-{a,--no-verify}}',
    '${X:-a',
  ])('is true for %s', word => {
    expect(operandMaySpellOption(pushedWord(word))).toBe(true)
  })

  it.each([
    'main',
    '${BRANCH}',
    '"${BRANCH:-main}"',
    '${BRANCH:-feat-x}',
    '${R:-origin}',
    '${X#-}',
    '${X%--x}',
    '${=X%--x}',
    '${X:0:1}',
    '${#X}',
    '${X/-/a}',
    '${X/--no-verify}',
    '${X:-main}',
    '${X-main}',
    '${X:=main}',
    '${X:+main}',
    '${X:?main}',
    '${X::=main}',
    '${X:h}',
    '${X:t:r}',
    '${X:h2}',
    '$X',
    "'${X:---no-verify}'",
  ])('is false for %s', word => {
    expect(operandMaySpellOption(pushedWord(word))).toBe(false)
  })
})
