import { parseTerms } from '@titan-design/egress-scan'
import { describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'

const TERM = 'zq7privateseat'

const ctx: GuardContext = {
  terms: { kind: 'ok', rules: parseTerms(`${TERM}\n`) },
  cwd: '/work',
  env: {},
  protectedPaths: ['titan-egress/private-terms', '.agent-chat/git-hooks'],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
}

describe('a ${...} expansion with an operator or flag on a gh line (CC-718)', () => {
  it.each([
    `echo \${X:-'\${Y}'}; gh pr create -t ${TERM} -b ok`,
    `echo \${X:='\${Y}'}; gh pr create -t ${TERM} -b ok`,
    `echo \${X:+'\${Y}'}; gh pr create -t ${TERM} -b ok`,
    `echo \${X:?'\${Y}'}; gh pr create -t ${TERM} -b ok`,
    `echo \${X#'\${Y}'}; gh pr create -t ${TERM} -b ok`,
    `echo \${X%'\${Y}'}; gh pr create -t ${TERM} -b ok`,
    `echo \${X/a/'\${Y}'}; gh pr create -t ${TERM} -b ok`,
    'echo "${X^^}"; gh pr create -t x -b ok',
    'echo ${#X}; gh pr create -t x -b ok',
    'echo ${!X}; gh pr create -t x -b ok',
    `X='\${functions[gh]::=command gh pr create -t ${TERM} -b ok}'; : \${(e)X}; gh pr view`,
    ': ${(e)X}; gh pr create -t x -b ok',
    'echo $(: ${X:-y}); gh pr create -t x -b ok',
    'echo "${T:-x}"; agent-chat gh-write -- pr create -t x -b ok',
  ])('denies %j', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.operatorExpansion)
  })

  it.each([
    `echo \${X:-'\${Y}'}; g''h pr create -t ${TERM} -b ok`,
    `echo \${X:-'\${Y}'}; A=g;B=h;$A$B pr create -t ${TERM} -b ok`,
    `echo \${X:-'\${Y}'}; eval 'g''h pr create -t ${TERM} -b ok'`,
    `X='\${functions[foo]::=command g''h pr create -t ${TERM} -b ok}'; : \${(e)X}; foo`,
    'echo "${X:-"y"}"',
    'echo ${X:-\\}}',
    'echo ${X:-${Y}}',
    'echo ${X:-$(true)}',
    'echo ${(e)X}',
  ])('denies %j on any line, since what follows the expansion is not what the shell runs', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.operatorExpansion)
  })

  it.each([
    'echo "${DIR:-.}"; git status',
    "gh pr create -t x -b '${X:-y}'",
    'echo "${T}" ${1}; gh pr create -t x -b ok',
    'echo ${HOME} ${1} ${10} $x "${HOME}"; gh pr create -t x -b ok',
    'echo ${X:-y} ${#X} ${X%.md}',
  ])('allows %j', command => {
    expect(checkCommand(command, ctx)).toBeUndefined()
  })
})
