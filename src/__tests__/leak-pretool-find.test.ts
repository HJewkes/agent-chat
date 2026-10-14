import { parseTerms } from '@titan-design/egress-scan'
import { describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'

const ctx: GuardContext = {
  terms: { kind: 'ok', rules: parseTerms('zq7privateseat\n') },
  cwd: '/work',
  env: {},
  protectedPaths: ['titan-egress/private-terms', '.agent-chat/git-hooks'],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
}

describe('find runs each action clause with the paths it finds in place of {} (CC-1223)', () => {
  it.each([
    'find . -exec env -u {} git push \\;',
    'find GIT_CONFIG_COUNT -maxdepth 0 -exec env -u {} git push \\;',
    'find . -exec env -u x{} git push \\;',
  ])('denies an env that unsets a name find fills: %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.gitConfigEnv)
  })

  it.each([
    'find . -exec git push --no-verify \\;',
    "find . -ok git push --no-verify ';'",
    'find . -okdir git push --no-verify \\;',
    'nice find . -exec git push --no-verify \\;',
    '/usr/bin/find . -execdir git push --no-verify {} +',
    'find . -exec true \\; -exec git push --no-verify \\;',
    'find . -exec true {} + -ok true \\; -exec git push --no-verify \\;',
  ])('denies a push that skips hooks in any clause: %s', command => {
    expect(checkCommand(command, ctx)).toBe(REASONS.noVerify)
  })

  it.each(['find . -execdir git push {} +', 'find . -exec git push origin {} \\;'])(
    'denies a push that may take --no-verify from a path: %s',
    command => {
      expect(checkCommand(command, ctx)).toBe(REASONS.xargsPush)
    },
  )

  it.each([
    "find . -exec sh -c 'git push {} --no-verify' \\;",
    'find . $X git push --no-verify \\;',
    'find . -name "$N" -exec git push --no-verify \\;',
    'find . -exec echo "$X" -exec git push --no-verify \\;',
  ])('denies a push behind a find word it cannot read: %s', command => {
    expect(checkCommand(command, ctx)).toBeDefined()
  })

  it.each([
    'find . -ok find . -exec true {} + -exec true \\; -o -exec git push --no-verify \\;',
    'find . -ok find . -exec true {} + -exec true \\; -o -exec env -u GIT_CONFIG_COUNT git push \\;',
    'find . -ok find . -exec true {} + -exec true \\; -o -exec git -c core.hooksPath=/tmp/h push \\;',
    'find . -ok find . -exec true {} + -exec true \\; -o -exec gh pr create --body zq7privateseat \\;',
    'GH_CONFIG_DIR=/tmp/x find . -ok find . -exec true {} + -exec gh pr create --body ok \\; \\;',
  ])('keeps the outer clauses after a find that has clauses of its own: %s', command => {
    expect(checkCommand(command, ctx)).toBeDefined()
  })

  it.each([
    "find . -name '*.ts' -exec grep -n foo {} \\;",
    'find . -exec grep -l x {} +',
    'find . -type f -print',
    'find . -exec git log -1 -- {} \\;',
    'find . -exec git add {} +',
    'find . -exec git push origin -- {} \\;',
    'find "$dir" -name \'*.ts\' -exec grep -l foo {} +',
    'find . -exec grep "$pat" {} \\; && git status',
    'find . -name x -delete && git push origin main',
  ])('allows a find that runs no risky command: %s', command => {
    expect(checkCommand(command, ctx)).toBeUndefined()
  })
})
