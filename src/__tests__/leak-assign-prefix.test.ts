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

  it('denies a GH_HOST append on its own line before an unresolved gh api read', () => {
    const read = 'gh api "repos/o/r/commits/$SHA/check-runs"'
    for (const prefix of [
      'GH_HOST+=github.com;',
      'GH_HOST=github.com GH_HOST+=github.com',
      'GH_HOST[0]=github.com;',
    ])
      expect(checkCommand(`${prefix} ${read}`, ctx()), prefix).toBeDefined()
  })

  it.each(['env A.B=1', 'env 1=2', 'env -- A.B=1', 'env A-B=1 C.D=2'])(
    'reads every word with an = after %s as an env assignment',
    prefix => {
      expect(checkCommand(`${prefix} git push --no-verify`, ctx())).toBeDefined()
      expect(checkCommand(`${prefix} gh issue comment 1 --body ${TERM}`, ctx())).toBeDefined()
    },
  )

  it('still allows env with an odd name before an ordinary command', () => {
    expect(checkCommand('env A.B=1 git status', ctx())).toBeUndefined()
  })

  describe('env -S and --split-string', () => {
    const forms = (split: string, rest = ''): string[] => [
      `env -S '${split}' ${rest}`,
      `env -S'${split}' ${rest}`,
      `env --split-string '${split}' ${rest}`,
      `env --split-string='${split}' ${rest}`,
    ]

    it.each([
      ...forms('A.B=1 git push --no-verify'),
      ...forms('1=2 git push --no-verify'),
      ...forms('A.B=1', 'git push --no-verify'),
      ...forms('-- A.B=1 git push --no-verify'),
      ...forms('A=1 git push --no-verify'),
      ...forms(`A.B=1 gh issue comment 1 --body ${TERM}`),
    ])('denies %s', command => {
      expect(checkCommand(command, ctx())).toBeDefined()
    })

    it.each([
      ...forms('FOO=1 npm test'),
      ...forms('A.B=1 git status').filter(c => !c.startsWith("env -S'")),
      ...forms('A.B=1', 'git status'),
    ])('allows %s', command => {
      expect(checkCommand(command, ctx())).toBeUndefined()
    })

    it.each([
      "env -S 'git\\_push\\_--no-verify'",
      "env -S 'A.B=1\\_git push --no-verify'",
      "env -S 'git push --no-verify\\c' x",
      "env -S 'A=1\ngit push --no-verify'",
      "env -S 'A=1\vgit push --no-verify'",
      "env -S 'A=1\fgit push --no-verify'",
      "env -S 'A=1\rgit push --no-verify'",
      "env -vS 'A.B=1 git push --no-verify'",
      "env -vS'A.B=1 git push --no-verify'",
      "env -vS 'A.B=1' git push --no-verify",
    ])('denies the env split-string form %j', command => {
      expect(checkCommand(command, ctx())).toBeDefined()
    })

    it.each(["env -S 'FOO=1 npm test'", "env -vS 'FOO=1 npm test'"])('allows %s', command => {
      expect(checkCommand(command, ctx())).toBeUndefined()
    })
  })
})
