import { parseTerms } from '@titan-design/egress-scan'
import { describe, expect, it } from 'vitest'
import { checkCommand, type GuardContext } from '../leak-guard/pretool.js'
import { parseShell } from '../leak-guard/shell-words.js'

// zsh reads `(a|b)` after a command name as a glob alternation, which can expand to `-c` and `push` (CC-728).
const ctx = (): GuardContext => ({
  terms: { kind: 'ok', rules: parseTerms('zq7privateseat\n') },
  cwd: '/work',
  env: {},
  protectedPaths: [],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
})

describe('zsh glob alternation as a command argument', () => {
  it.each([
    'git --no-pager (-c|core.hooksPath=h|push) origin HEAD:refs/heads/viaGlob',
    'git (push|-c) origin main',
    'git push origin (--no-verify|main)',
    'git push origin (a|--no-verify)',
    'git x(-c|y) push',
  ])('denies %j', command => {
    expect(checkCommand(command, ctx())).toBeDefined()
  })

  it('reads the alternation as a word of the command, not a subshell', () => {
    const [cmd] = parseShell('git (a|b) c')
    expect(cmd?.words).toEqual(['git', '(a|b)', 'c'])
    expect(cmd?.nested).toBe(false)
  })

  it('still opens a subshell at command position', () => {
    const cmds = parseShell('(cd x && git status)')
    expect(cmds.map(c => c.words)).toEqual([
      ['cd', 'x'],
      ['git', 'status'],
    ])
    expect(cmds.every(c => c.nested)).toBe(true)
  })

  it.each(['(cd x && git status)', 'git status'])('keeps allowing %j', command => {
    expect(checkCommand(command, ctx())).toBeUndefined()
  })
})
