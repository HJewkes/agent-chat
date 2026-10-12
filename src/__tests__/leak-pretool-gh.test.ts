import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseTerms } from '@titan-design/egress-scan'
import { afterEach, describe, expect, it } from 'vitest'
import { ghAliasReader, ghPlainAlias, type GhAlias } from '../leak-guard/gh-runs.js'
import { checkCommand, guardContext, readText, REASONS, type GuardContext } from '../leak-guard/pretool.js'

// Synthetic only.
const TERM = 'zq7privateseat'

const aliases =
  (table: Record<string, GhAlias>) =>
  (name: string): GhAlias | undefined =>
    table[name]

const ctx = (table: Record<string, GhAlias> = {}): GuardContext => ({
  terms: { kind: 'ok', rules: parseTerms(`${TERM}\n`) },
  cwd: '/work',
  env: { HOME: '/srv/agent' },
  protectedPaths: [],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
  readGhAlias: aliases(table),
})

/** A new reason is undefined on the code before it, so the deny itself is asserted first. */
const expectDeny = (actual: string | undefined, reason: string): void => {
  expect(reason).toBeDefined()
  expect(actual).toBe(reason)
}

const NO_VERIFY_SHELL = { shell: true, body: 'git push --no-verify' }

describe('a gh alias (TP-2371)', () => {
  it('denies a shell alias that hands its argument to a git program env, set and run on one line', () => {
    const command = `gh alias set --shell x 'GIT_PAGER="$1" git log'; gh x`
    expectDeny(checkCommand(command, ctx()), REASONS.programEnv)
  })

  it.each([
    `gh alias set --shell x 'git push --no-verify'`,
    `gh alias set -s x 'git push --no-verify'`,
    `gh alias set --shell=true x 'git push --no-verify'`,
    `gh alias set x '!git push --no-verify'`,
    `gh alias set --clobber x '!git push --no-verify'`,
    `gh alias set -- x '!git push --no-verify'`,
  ])('denies setting a shell alias that skips the pre-push scan: %s', command => {
    expectDeny(checkCommand(command, ctx()), REASONS.noVerify)
  })

  it('checks a plain alias body as the gh command it expands to', () => {
    const command = `gh alias set x 'alias set y "!git push --no-verify"'`
    expectDeny(checkCommand(command, ctx()), REASONS.noVerify)
  })

  it.each([`gh alias import aliases.yml`, `gh alias import -`, `gh alias set x - < body.txt`])(
    'denies an alias definition the guard does not read: %s',
    command => {
      expectDeny(checkCommand(command, ctx()), REASONS.ghAliasUnread)
    },
  )

  it.each([`gh alias set x "$BODY"`, `gh alias "$VERB" x 'pr list'`])(
    'denies an alias definition with a word the guard cannot resolve: %s',
    command => {
      expectDeny(checkCommand(command, ctx()), REASONS.ghAliasHidden)
    },
  )

  it('denies running a shell alias whose config body skips the pre-push scan', () => {
    expectDeny(checkCommand('gh pv', ctx({ pv: NO_VERIFY_SHELL })), REASONS.noVerify)
  })

  it('fills a shell alias argument into its body before checking it', () => {
    const table = { rx: { shell: true, body: 'git push origin $1' } }
    expectDeny(checkCommand('gh rx --no-verify', ctx(table)), REASONS.noVerify)
  })

  it('denies a shell alias run with an argument the guard cannot resolve', () => {
    const table = { rx: { shell: true, body: 'git push origin $1' } }
    expectDeny(checkCommand('gh rx "$FLAG"', ctx(table)), REASONS.ghAliasHidden)
  })

  it('follows a plain alias into the alias it expands to', () => {
    const table = { pv: { shell: false, body: 'zz' }, zz: NO_VERIFY_SHELL }
    expectDeny(checkCommand('gh pv', ctx(table)), REASONS.noVerify)
  })

  it('follows an alias nested under a gh command group', () => {
    expectDeny(checkCommand('gh issue mine', ctx({ 'issue mine': NO_VERIFY_SHELL })), REASONS.noVerify)
  })

  it('stops an alias that expands to itself', () => {
    expectDeny(checkCommand('gh loop', ctx({ loop: { shell: false, body: 'loop' } })), REASONS.aliasDepth)
  })

  it.each([
    `gh alias set y 'pr list'; gh y`,
    `gh config set editor vi && gh y`,
    `cp mine.yml ~/.config/gh/config.yml; gh y`,
  ])('denies a gh word that may be an alias on a line that writes gh config: %s', command => {
    expectDeny(checkCommand(command, ctx()), REASONS.ghAliasWritten)
  })

  it.each(['GH_CONFIG_DIR=/tmp/x gh pv', 'export XDG_CONFIG_HOME=/tmp/x; gh pv', 'env HOME=/tmp/x gh pv'])(
    'denies a gh word that may be an alias read from another config: %s',
    command => {
      expectDeny(checkCommand(command, ctx()), REASONS.ghAliasEnv)
    },
  )

  it.each([
    'gh alias list',
    'gh alias delete x',
    'gh co 12',
    'gh pr view 1',
    `gh alias set prs 'pr list --author @me'`,
    `gh alias set --shell st 'git status'`,
    'gh repo clone o/r',
    'gh nosuchword',
    'GH_CONFIG_DIR=/tmp/x gh repo view',
    'gh pv 7',
  ])('allows %s', command => {
    const table = { co: { shell: false, body: 'pr checkout' }, pv: { shell: false, body: 'pr view' } }
    expect(checkCommand(command, ctx(table))).toBeUndefined()
  })
})

describe('gh plain alias expansion', () => {
  it('fills $N in the text, then appends what is left once no $ remains', () => {
    expect(ghPlainAlias('pr view $1', ['7', '-w'])).toEqual(['pr', 'view', '7', '-w'])
  })

  it('appends every argument to an expansion with no $', () => {
    expect(ghPlainAlias('pr checkout', ['12'])).toEqual(['pr', 'checkout', '12'])
  })

  it('runs nothing when a $N is left unfilled', () => {
    expect(ghPlainAlias('issue list --author="$1"', [])).toBeUndefined()
  })
})

describe('ghAliasReader', () => {
  const dirs: string[] = []
  const scratch = (config: string | undefined): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-alias-'))
    dirs.push(dir)
    if (config !== undefined) fs.writeFileSync(path.join(dir, 'config.yml'), config)
    return dir
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  const CONFIG = `version: 1\naliases:\n    co: pr checkout\n    rx: '!git push $1'\n`

  it('reads shell and plain aliases from GH_CONFIG_DIR', () => {
    const read = ghAliasReader({ GH_CONFIG_DIR: scratch(CONFIG) }, readText)
    expect(read('co')).toEqual({ shell: false, body: 'pr checkout' })
    expect(read('rx')).toEqual({ shell: true, body: 'git push $1' })
    expect(read('constructor')).toBeUndefined()
  })

  it('reads from XDG_CONFIG_HOME/gh, then ~/.config/gh', () => {
    const xdg = scratch(undefined)
    fs.mkdirSync(path.join(xdg, 'gh'))
    fs.writeFileSync(path.join(xdg, 'gh', 'config.yml'), CONFIG)
    expect(ghAliasReader({ XDG_CONFIG_HOME: xdg }, readText)('co')?.body).toBe('pr checkout')
    const home = scratch(undefined)
    fs.mkdirSync(path.join(home, '.config', 'gh'), { recursive: true })
    fs.writeFileSync(path.join(home, '.config', 'gh', 'config.yml'), CONFIG)
    expect(ghAliasReader({ HOME: home }, readText)('co')?.body).toBe('pr checkout')
  })

  it.each([
    ['a missing file', undefined],
    ['malformed yaml', 'aliases: [unclosed\n'],
    ['aliases that are not a map', 'aliases: 3\n'],
  ])('reads no alias, without throwing, from %s', (_, config) => {
    expect(ghAliasReader({ GH_CONFIG_DIR: scratch(config) }, readText)('co')).toBeUndefined()
  })

  it('is wired into the hook context from the hook environment', () => {
    const dir = scratch(`aliases:\n    pv: '!git push --no-verify'\n`)
    const context = guardContext({ GH_CONFIG_DIR: dir, PATH: '' }, '/work', '/nonexistent-home')
    expectDeny(checkCommand('gh pv', context), REASONS.noVerify)
  })
})
