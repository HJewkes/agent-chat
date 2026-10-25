import { parseTerms } from '@titan-design/egress-scan'
import { describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'

const ctx: GuardContext = {
  terms: { kind: 'ok', rules: parseTerms('zq7privateseat\n') },
  cwd: '/work',
  env: {},
  protectedPaths: [],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
}

const deny = (command: string, reason: string | undefined): void => {
  expect(reason).toBeDefined()
  expect(checkCommand(command, ctx)).toBe(reason)
}

describe('an env -S value read as env splits it, operators kept as words (CC-1307)', () => {
  it.each([
    "env -S 'find . -exec true ; -exec git push --no-verify ;'",
    'env --split-string="find . -exec true ; -exec git push --no-verify ;"',
    "env -S 'git push origin main;git push --no-verify'",
    "env -S 'git push origin main | --no-verify'",
  ])('denies the push in a later find clause or word: %s', command => {
    deny(command, REASONS.noVerify)
  })

  it('denies gh in a later find clause under an env that sets GH_CONFIG_DIR', () => {
    deny("env GH_CONFIG_DIR=/x -S 'find . -exec true ; -exec gh pr create --body ok ;'", REASONS.ghConfigHome)
  })

  it('denies a value with an unclosed quote, which env refuses to split', () => {
    deny('env -S "echo \'x"', REASONS.hiddenCommand)
  })

  // Both already deny before CC-1307: xargs words may be any command, and env -S refuses a backslash.
  it.each([
    "xargs env -S 'find . -exec true ; -exec git push'",
    "env -S 'find . -exec true \\; -exec git push --no-verify \\;'",
  ])('denies %s as a hidden command', command => {
    deny(command, REASONS.hiddenCommand)
  })

  it.each([
    "env -S 'find . -name x -exec true ;'",
    "env -S 'echo a;b'",
    'env -S "git commit -m \'a;b\'"',
    "env -S 'git status; git log'",
    'env -S \'echo "git push --no-verify;"\'',
  ])('allows a value whose words run nothing checked: %s', command => {
    expect(checkCommand(command, ctx)).toBeUndefined()
  })
})
