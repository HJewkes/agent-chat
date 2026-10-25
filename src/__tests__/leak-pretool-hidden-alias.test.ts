import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseTerms } from '@titan-design/egress-scan'
import { afterAll, describe, expect, it } from 'vitest'
import { aliasReader, type ReadAlias } from '../leak-guard/git-alias.js'
import { checkCommand, REASONS, type GuardContext } from '../leak-guard/pretool.js'

// `p` and `b` are aliases only in /work, so a lookup made anywhere else finds nothing.
const WORK_ALIASES: Record<string, string> = { p: 'push --no-verify', b: '!git push --no-verify origin HEAD' }
const readAlias: ReadAlias = (word, dir) =>
  dir === '/work' && WORK_ALIASES[word] !== undefined
    ? { value: WORK_ALIASES[word], runsIn: '/work' }
    : undefined

const ctx: GuardContext = {
  terms: { kind: 'ok', rules: parseTerms('zq7privateseat\n') },
  cwd: '/work',
  env: {},
  protectedPaths: [],
  readFile: () => undefined,
  readAlias,
  readIncludedHooksPath: () => false,
}

const deny = (command: string, reason: string | undefined, at: GuardContext = ctx): void => {
  expect(reason).toBeDefined()
  expect(checkCommand(command, at)).toBe(reason)
}

describe('an untied hidden command word whose directory or env is unknown (CC-1315)', () => {
  it.each([
    'env -C /x $X p',
    'env -C /x "$X" p',
    'env --chdir=/x $X p',
    'env -C "$D" $X p',
    'sudo $X p',
    'sudo -u bob $X p',
    'cd "$D" && $X p',
    'source x; $X p',
    'eval x; $X p',
    'HOME=$H $X p',
    '$A "$B" p',
    '$A b "$B" p',
  ])('reads the alias where the hook runs when the directory is unknown: %s', command => {
    deny(command, REASONS.noVerify)
  })

  it('reads the alias with the hook env when the command sets one the guard cannot read', () => {
    deny('GIT_DIR=$G $X p', REASONS.noVerify)
  })

  // A git option value the line hides is itself a hidden word, so the suffix scan checks it as a command.
  it.each([
    ['D=$(mktemp -d); $X -C "$D" p', REASONS.aliasHidden],
    ['read D; $X -C "$D" p', REASONS.aliasHidden],
    ['source x; $X -C "$D" p', REASONS.noVerify],
    ['source x; $X -C"$D" p', REASONS.noVerify],
    ['read D; env -C /x $X -C "$D" p', REASONS.aliasHidden],
    ['$X --git-dir="$(mktemp)" p', REASONS.aliasHidden],
    ['read G; $X --git-dir "$G" p', REASONS.aliasHidden],
    ['source x; $X --git-dir=$G p', REASONS.aliasHidden],
    ['env -C /x $X --git-dir=$G p', REASONS.aliasHidden],
    ['C=$(x); $X -c "$C" p', REASONS.aliasHidden],
    ['source x; $X -c"$C" p', REASONS.noVerify],
    ['sudo $X -c"$C" p', REASONS.noVerify],
    ['read E; $X --config-env="$E" p', REASONS.aliasHidden],
    ['source x; $X --work-tree=$W p', REASONS.noVerify],
  ])('denies a hidden git option value before an alias: %s', (command, reason) => {
    deny(command, reason)
  })

  it.each(['find . -execdir $X p \\;', 'find . -exec true \\; -execdir "$X" p \\;'])(
    'reads the alias where the hook runs for a find -execdir command: %s',
    command => {
      deny(command, REASONS.noVerify)
    },
  )

  it('checks a ! alias found where the hook runs as the shell command it runs', () => {
    deny('env -C /x $X b', REASONS.noVerify)
  })

  it.each(['git p', '$X p', 'cd /work && $X p'])(
    'still reads the alias in the known directory: %s',
    command => {
      deny(command, REASONS.noVerify)
    },
  )

  it('looks in a known directory, not the hook one, when the command cds there', () => {
    expect(checkCommand('cd /y && $X p', ctx)).toBeUndefined()
  })

  it('keeps aliasEnv for literal git in an unknown directory', () => {
    deny('env -C /x git p', REASONS.aliasEnv)
  })

  it('keeps aliasHidden for a word the line ties to git in an unknown directory', () => {
    deny('x=git; env -C /x $x p', REASONS.aliasHidden)
  })

  it.each([
    'env -C /x $X q',
    'env -C /x $X status',
    'sudo $EDITOR notes',
    'cd "$D" && $EDITOR notes',
    'source x; $PAGER README; git log',
    'source x; ${EDITOR:-vi} notes; git log',
    'source x; $PYTHON -m pytest && git status',
  ])('allows a hidden command word with no alias where the hook runs: %s', command => {
    expect(checkCommand(command, ctx)).toBeUndefined()
  })
})

describe('the hook-directory lookup through git config (CC-1315)', () => {
  const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-hidden-alias-'))
  afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }))

  const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  const emptyHome = path.join(SCRATCH, 'empty-home')
  const READ_ENV: NodeJS.ProcessEnv = { ...process.env, HOME: emptyHome, XDG_CONFIG_HOME: emptyHome }
  READ_ENV.GIT_CONFIG_NOSYSTEM = '1'
  for (const name of ['GIT_CONFIG_GLOBAL', 'GIT_DIR', 'GIT_WORK_TREE']) delete READ_ENV[name]

  const aliased = path.join(SCRATCH, 'aliased')
  execFileSync('git', ['init', '-q', aliased], { env: GIT_ENV })
  execFileSync('git', ['-C', aliased, 'config', 'alias.pnv', 'push --no-verify'], { env: GIT_ENV })
  const plain = path.join(SCRATCH, 'plain')
  execFileSync('git', ['init', '-q', plain], { env: GIT_ENV })
  const at = (cwd: string): GuardContext => ({ ...ctx, cwd, readAlias: aliasReader(READ_ENV) })

  it.each(['env -C /tmp $X pnv', 'sudo $X pnv'])(
    'denies a repo alias read in the hook directory: %s',
    command => {
      deny(command, REASONS.noVerify, at(aliased))
    },
  )

  it('allows the same command where the hook directory has no such alias', () => {
    expect(checkCommand('env -C /tmp $X pnv', at(plain))).toBeUndefined()
  })
})
