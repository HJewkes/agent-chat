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
    'echo "${DIR:-.}"; git status',
    "gh pr create -t x -b '${X:-y}'",
    'echo "${T}" ${1}; gh pr create -t x -b ok',
    'echo ${X:-y}',
  ])('allows %j', command => {
    expect(checkCommand(command, ctx)).toBeUndefined()
  })
})
