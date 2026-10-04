import { parseTerms } from '@titan-design/egress-scan'
import { describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'

// Synthetic only.
const TERM = 'zq7privateseat'

const ctx = (): GuardContext => ({
  terms: { kind: 'ok', rules: parseTerms(`${TERM}\n`) },
  cwd: '/work',
  env: {},
  protectedPaths: [],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
})

// Each prefix is one the shell reads as an assignment, so the next word is the command.
const PREFIXES = ['A+=1', 'A[0]=1', 'A[0]+=1', 'A["k b"]=1', "A['k']+=1", 'A[$i]=1', 'A[i+1]=1', 'A[1]=x=y']

const COMMANDS = [
  'git push --no-verify',
  `gh issue comment 1 --body ${TERM}`,
  `gh api -X POST repos/o/r/issues/1/comments -f body=${TERM}`,
  '/usr/bin/env git push --no-verify',
  'env -i git push --no-verify',
  'command git push --no-verify',
  'nice git push --no-verify',
]

describe('a NAME+= or NAME[idx]= prefix is an assignment like NAME=', () => {
  for (const prefix of PREFIXES)
    for (const command of COMMANDS)
      it(`${prefix} ${command}`, () => {
        const plain = checkCommand(`A=1 ${command}`, ctx())
        expect(plain).toBeDefined()
        expect(checkCommand(`${prefix} ${command}`, ctx())).toBe(plain)
      })

  it('reads a GH_HOST append as a reroute of a gh api read', () => {
    const plain = checkCommand('GH_HOST=evil.example gh api "repos/o/r/commits/$SHA/check-runs"', ctx())
    expect(plain).toBe(REASONS.ghApiHost)
    expect(checkCommand('GH_HOST+=evil.example gh api "repos/o/r/commits/$SHA/check-runs"', ctx())).toBe(
      plain,
    )
  })

  it('reads env after a prefix as the command it runs', () => {
    expect(checkCommand('ZQ+=b /usr/bin/env git push --no-verify', ctx())).toBeDefined()
  })

  it('denies GIT_CONFIG_* set through an append or subscript', () => {
    for (const word of ['GIT_CONFIG_COUNT+=1', 'GIT_CONFIG_VALUE_0[1]=/tmp'])
      expect(checkCommand(`${word} git push`, ctx())).toBe(REASONS.gitConfigEnv)
  })

  it('denies a subscript that never closes into an assignment', () => {
    for (const command of [
      'A[a b]=1 git push --no-verify',
      'A[x=1 git push --no-verify',
      'env A[x git push --no-verify',
    ])
      expect(checkCommand(command, ctx()), command).toBeDefined()
  })

  it('names the subscript when nothing else would deny the command', () => {
    expect(checkCommand('A[a b]=1 git status', ctx())).toBe(REASONS.assignmentSubscript)
  })

  it.each([
    'A+=1 git status',
    'PATH+=:/x git log',
    'A[0]=1 git status',
    'A[0]+=1 git log',
    'env A+=1 git status',
  ])('still allows %s', command => expect(checkCommand(command, ctx())).toBeUndefined())
})
