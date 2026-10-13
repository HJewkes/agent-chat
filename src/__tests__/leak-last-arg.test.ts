import { describe, expect, it } from 'vitest'
import { readsLastArg, runsHistory } from '../leak-guard/last-arg.js'
import { parseShell } from '../leak-guard/shell-words.js'

const only = (line: string) => {
  const cmd = parseShell(line)[0]
  if (cmd === undefined) throw new Error(`no command in ${line}`)
  return cmd
}

const lastWord = (line: string): string => only(line).marked.at(-1) ?? ''

const history = (line: string): boolean => {
  const cmd = only(line)
  return runsHistory(cmd.words[0] ?? '', cmd.marked.slice(1))
}

describe('a word that reads an earlier command argument (CC-1287)', () => {
  it.each([
    'git push origin main$_',
    'git push origin "$_"',
    'git push origin ${_}',
    'git push origin "${_}"',
    'git push origin ${_#x}',
    'git push origin ${_:1}',
    'git push origin $=_',
    'git push origin ${=_}',
    'git push origin ${(L)_}',
    'git push origin main$PWD',
    'git push origin ${OLDPWD}',
    'git push origin "main$_"',
    'git push origin ${X:-$_}',
    'git push origin ${X-$_}',
    'git push origin ${X+$_}',
    'git push origin ${X:=$PWD}',
    'git push origin "${X:-${Y:-$OLDPWD}}"',
    'git push origin ${${_}}',
    'git push origin ${(s:):)_}',
  ])('%s reads it', line => {
    expect(readsLastArg(lastWord(line))).toBe(true)
  })

  it.each([
    "git push origin '$_'",
    'git push origin $_x',
    'git push origin $_foo',
    'git push origin ${_x}',
    'git push origin $MY_PWD',
    'git push origin ${PWDX}',
    'git push origin ${X:-_}',
    'git push origin main',
    'git push origin $HOME',
  ])('%s does not', line => {
    expect(readsLastArg(lastWord(line))).toBe(false)
  })
})

describe('a command that runs history text (CC-1287)', () => {
  it.each([
    'set -H',
    'set -eH',
    'set -o histexpand',
    'set -$X',
    'shopt -so histexpand',
    'shopt -s -o histexpand',
    'shopt -o -s $X',
    'fc -s',
    'fc -e -',
    'fc -$X',
    'fc',
    'fc -l -s',
    'fc -ls',
    'fc -lr -s',
    'fc -nl -s',
    'fc -l -e -',
    'fc -l $X',
    'r',
  ])('%s runs it', line => {
    expect(history(line)).toBe(true)
  })

  it.each([
    'set -e',
    'set -o pipefail',
    'set -- a',
    'shopt -s nullglob',
    'fc -l',
    'fc -ln -5',
    'fc -lr 1 5',
    'history -s x',
  ])('%s does not', line => {
    expect(history(line)).toBe(false)
  })
})
