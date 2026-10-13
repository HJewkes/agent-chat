import { describe, expect, it } from 'vitest'
import { parseShell } from '../leak-guard/shell-words.js'
import { appliesZshModifier } from '../leak-guard/zsh-modifier.js'

/** Asks about the last word of the push line the real splitter reads for `word`. */
function pushWordModifies(word: string): boolean {
  const [cmd] = parseShell(`git push origin ${word}`)
  if (cmd === undefined) throw new Error(`no command for ${word}`)
  return appliesZshModifier(cmd.marked.at(-1) as string)
}

describe('an unbraced zsh modifier in a shell word (CC-1290)', () => {
  it.each([
    '$X:s/a/-b/',
    '"$X:s/a/-b/"',
    'main$X:s/a/-b/',
    '$X[1]:s/a/-b/',
    '$~X:s/a/-b/',
    '$=X:s/a/\\ -b/',
    '$1:s/a/-b/',
    '$#X:s/1/-b/',
    '$_:s/a/-b/',
    '$X:t',
    '$X:h2',
    '$X:gs/a/-b/',
    '"$X:&"',
    '$M:refs/heads/x',
    '$?:s/0/-b/',
    '"$?:s/0/-b/"',
    '$*:s/a/-b/',
    '$$:s/1/-b/',
    '$#*:s/1/-b/',
    '$@:s/a/-b/',
    '$!:s/a/-b/',
    '$-:s/a/-b/',
    '$X[$Y[1]]:s/b/-b/',
    '"$X[$Y[1]]:s/b/-b/"',
  ])('applies in %s', word => {
    expect(pushWordModifies(word)).toBe(true)
  })

  it.each([
    '${X}:s/a/b/',
    '"${B}:refs/heads/x"',
    '${X:s/a/b/}',
    'HEAD:$B',
    '"$B:$B"',
    '$X:$Y',
    '$R:main',
    '"$X:-x"',
    'main',
    "'$X:s/a/-b/'",
    '$X:S',
  ])('does not apply in %s', word => {
    expect(pushWordModifies(word)).toBe(false)
  })

  it('fails closed on a quoted colon, which zsh leaves literal but marks the same', () => {
    expect(pushWordModifies("$X':s/a/b/'")).toBe(true)
  })

  it.each([...'aAcefFghlpPqQrstuwWxX&'])('applies with the modifier letter %s', letter => {
    expect(pushWordModifies(`"$X:${letter}"`)).toBe(true)
  })
})
