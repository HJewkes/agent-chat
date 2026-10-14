import { describe, expect, it } from 'vitest'
import { splicesIfs } from '../leak-guard/ifs-splice.js'
import { parseShell } from '../leak-guard/shell-words.js'

/** Asks about the word at `index` of the first command the real splitter reads from `line`. */
function wordSplices(line: string, index: number): boolean {
  const [cmd] = parseShell(line)
  if (cmd === undefined) throw new Error(`no command in ${line}`)
  return splicesIfs(cmd.marked[index] as string, cmd.splits)
}

describe('an unquoted $IFS reference in a shell word (CC-1284)', () => {
  it.each([
    ['git push origin main$IFS--no-verify', 3],
    ['git push origin main${IFS}--no-verify', 3],
    ['git push origin $IFS--no-verify', 3],
    ["git$IFS''push origin main --no-verify", 0],
    ['zsh -c x ${=IFS}', 3],
    ['zsh -c x $=IFS', 3],
    ['x ${IFS:0:1}', 1],
    ['x ${IFS#?}', 1],
    ['x "$X"$IFS', 1],
  ])('splices in %s', (line, index) => {
    expect(wordSplices(line, index)).toBe(true)
  })

  it.each([
    ['git push origin "main$IFS--no-verify"', 3],
    ["git push origin '$IFS'", 3],
    ['git push origin $MYIFS', 3],
    ['git push origin ${MYIFS}', 3],
    ['git push origin ${IFSX}', 3],
    ['git push origin main--no-verify', 3],
  ])('does not splice in %s', (line, index) => {
    expect(wordSplices(line, index)).toBe(false)
  })

  it('fails closed on a bare name that only starts with IFS, which quote removal makes ambiguous', () => {
    expect(wordSplices('git push origin $IFSX', 3)).toBe(true)
  })
})
