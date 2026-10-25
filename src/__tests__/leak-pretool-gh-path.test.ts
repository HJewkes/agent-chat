import { describe, expect, it } from 'vitest'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'

// Synthetic only.
const ENV = { HOME: '/srv/agent', PATH: '/usr/local/bin:/usr/bin:/bin' }

const ctx = (aliases: Record<string, string> = {}, env: Record<string, string> = ENV): GuardContext => ({
  terms: { kind: 'ok', rules: [] },
  cwd: '/work',
  env,
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
    expect(checkCommand('GH_PATH=/opt/x gh sg', ctx({ sg: 'auth setup-git' }))).toBe(
      REASONS.ghCredentialHelper,
    )
  })

  it.each([
    `PATH="/srv/a';echo probe;':$PATH" gh auth setup-git`,
    `PATH=/opt/bin:/usr/bin gh auth setup-git`,
    `export PATH=/opt/bin:$PATH; gh auth login`,
    `env PATH=/opt/bin gh auth refresh`,
  ])('denies %s, since gh writes the PATH entry that finds it (adversary on #1219)', command => {
    expect(checkCommand(command, ctx())).toBe(REASONS.ghCredentialHelper)
  })

  it("denies zsh's path array before gh auth setup-git", () => {
    expect(checkCommand('path=(/opt/bin $path); gh auth setup-git', ctx())).toBeDefined()
  })

  it('denies a prefix PATH on a gh alias that runs setup-git', () => {
    expect(checkCommand('PATH=/opt/bin gh sg', ctx({ sg: 'auth setup-git' }))).toBe(
      REASONS.ghCredentialHelper,
    )
  })

  it.each([
    { GH_PATH: "/srv/a';echo probe;'" },
    { PATH: "/srv/a';echo probe;':/usr/bin" },
    { PATH: '.:/usr/bin' },
    { PATH: '/usr/bin::/bin' },
  ])('denies bare gh auth setup-git when the hook env is %o', env => {
    expect(checkCommand('gh auth setup-git', ctx({}, { ...ENV, ...env }))).toBe(REASONS.ghCredentialHelper)
  })

  it.each([
    `unset GH_PATH; GH_PATH="/tmp/x';echo probe;'" bash -c 'gh auth setup-git'`,
    `export PATH="$PATH"; PATH="/tmp/q';echo probe;':$PATH" bash -c 'gh auth setup-git'`,
    'unset GH_PATH; function f { gh auth setup-git; }; GH_PATH=/x f',
  ])('denies %s, since the wrapper carries its prefix to gh (adversary round 2 on #1219)', command => {
    expect(checkCommand(command, ctx())).toBe(REASONS.ghCredentialHelper)
  })

  it.each([
    `unset GH_PATH; GH_PATH=/x sh -c 'gh auth setup-git'`,
    'unset GH_PATH; GH_PATH=/x eval gh auth setup-git',
    'unset GH_PATH; gh auth setup-git',
    'export GH_""PATH=/x; gh auth setup-git',
    'echo "${PATH:=/x}"; gh auth setup-git',
  ])(
    'denies %s, since a wrapper or obfuscation may carry the name to gh (adversary round 2 on #1219)',
    command => {
      expect(checkCommand(command, ctx())).toBeDefined()
    },
  )

  it.each([
    'gh auth setup-git',
    'echo "$PATH"; gh auth setup-git',
    'echo "${GH_PATH}"; gh auth setup-git',
    'PATH=/opt/bin gh auth status',
    'gh auth setup-git --hostname github.com',
    'GH_PATH=/opt/x gh auth status',
    'GH_PATH=/opt/x gh pr view 1',
    'gh sg',
  ])('allows %s', command => {
    expect(checkCommand(command, ctx({ sg: 'auth setup-git' }))).toBeUndefined()
  })
})
