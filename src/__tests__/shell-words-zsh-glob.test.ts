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
    'git ((-c|zz)|core.hooksPath=h|push) origin HEAD:refs/heads/x',
    "git (-c|core.hooksPath='h'|push) origin HEAD:refs/heads/x",
    'git (-c|core.hooksPath=h|push|<1-2>) origin HEAD:refs/heads/x',
    'git (-c|core.hooksPath=h|push|a\\ b) origin HEAD:refs/heads/x',
    'git (-c) core.hooksPath=h push origin HEAD:refs/heads/x',
    'git (-c core.hooksPath=h push origin HEAD:refs/heads/x',
    'git commit -m y (--no-verify|x)',
    'coproc (git -c core.hooksPath=h push origin HEAD:refs/heads/x)',
    'repeat 1 (git -c core.hooksPath=h push origin HEAD:refs/heads/x)',
    'for i (1) git -c core.hooksPath=h push origin HEAD:refs/heads/x',
    'for i (1) { git -c core.hooksPath=h push origin HEAD:refs/heads/x; }',
    'foreach i (1) git -c core.hooksPath=h push origin HEAD:refs/heads/x; end',
    'select i in a; do :; done; select x (git -c core.hooksPath=h push origin HEAD:refs/heads/x)',
    'noglob (git -c core.hooksPath=h push origin HEAD:refs/heads/x)',
    'nocorrect (git -c core.hooksPath=h push origin HEAD:refs/heads/x)',
    'builtin (git -c core.hooksPath=h push origin HEAD:refs/heads/x)',
    'exec (git -c core.hooksPath=h push origin HEAD:refs/heads/x)',
    'command (git -c core.hooksPath=h push origin HEAD:refs/heads/x)',
    '- (git -c core.hooksPath=h push origin HEAD:refs/heads/x)',
    'time -p (git -c core.hooksPath=h push origin HEAD:refs/heads/x)',
    'function f (git -c core.hooksPath=h push origin HEAD:refs/heads/x)',
    "git push origin (a|'--no-verify')",
    'git push origin (a|)--no-verify',
    'git push origin (a|\\\\--no-verify)',
    'git push origin --no-verif(y|z)',
    'case a in (a|b) git -c core.hooksPath=h push origin HEAD:refs/heads/x;; esac',
  ])('denies %j', command => {
    expect(checkCommand(command, ctx())).toBeDefined()
  })

  it('reads the alternation as a word of the command, not a subshell', () => {
    // A second reading, as a subshell followed by a command, is kept beside it.
    const cmd = parseShell('git (a|b) c').find(c => c.words[0] === 'git')
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

  it.each([
    '(cd x && git status)',
    'git status',
    '[[ a == (a|b) ]] && git status',
    'case a in (a|b) git status;; esac',
  ])('keeps allowing %j', command => {
    expect(checkCommand(command, ctx())).toBeUndefined()
  })
})
