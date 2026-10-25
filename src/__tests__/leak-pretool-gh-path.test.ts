import { describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'

// Synthetic only.
const ctx = (aliases: Record<string, string> = {}): GuardContext => ({
  terms: { kind: 'ok', rules: [] },
  cwd: '/work',
  env: { HOME: '/srv/agent' },
  protectedPaths: [],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
  readGhAliases: () => ({
    kind: 'ok',
    aliases: new Map(Object.entries(aliases).map(([name, body]) => [name, { shell: false, body }])),
  }),
})

describe('GH_PATH on a gh command that writes the credential helper (TP-2946)', () => {
  it.each([
    `GH_PATH='git push --no-verify' gh auth setup-git`,
    `export GH_PATH='git push --no-verify'; gh auth setup-git`,
    `env GH_PATH='git push --no-verify' gh auth setup-git`,
    `GH_PATH=/opt/x gh auth setup-git --hostname github.com`,
    `GH_PATH=/opt/x gh auth login --git-protocol https`,
    `GH_PATH=/opt/x gh auth refresh`,
    `GH_PATH=/opt/x gh auth "$SUB"`,
    `declare -x GH_PATH=/opt/x; gh auth setup-git`,
  ])('denies %s', command => {
    expect(checkCommand(command, ctx())).toBe(REASONS.ghCredentialHelper)
  })

  it('denies a prefix GH_PATH on a gh alias that runs setup-git', () => {
    expect(checkCommand('GH_PATH=/opt/x gh sg', ctx({ sg: 'auth setup-git' }))).toBe(REASONS.ghCredentialHelper)
  })

  it.each([
    'gh auth setup-git',
    'gh auth setup-git --hostname github.com',
    'unset GH_PATH; gh auth setup-git',
    'GH_PATH=/opt/x gh auth status',
    'GH_PATH=/opt/x gh pr view 1',
    'gh sg',
  ])('allows %s', command => {
    expect(checkCommand(command, ctx({ sg: 'auth setup-git' }))).toBeUndefined()
  })
})
