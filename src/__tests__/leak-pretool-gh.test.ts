import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseTerms } from '@titan-design/egress-scan'
import { afterEach, describe, expect, it } from 'vitest'
import { positionalUses } from '../leak-guard/git-alias.js'
import {
  ghAliasReader,
  ghAliasSet,
  ghCloneArgs,
  ghCommandWords,
  GH_BUILTINS,
  ghPlainAlias,
  HIDDEN,
  parseGhAliases,
  type GhAlias,
} from '../leak-guard/gh-runs.js'
import {
  checkCommand,
  denyOutput,
  guardContext,
  pretoolDecision,
  readText,
  REASONS,
  type GuardContext,
} from '../leak-guard/pretool.js'

// Synthetic only.
const TERM = 'zq7privateseat'

const aliases = (table: Record<string, GhAlias>) => () => ({
  kind: 'ok' as const,
  aliases: new Map(Object.entries(table)),
})

const ctx = (table: Record<string, GhAlias> = {}): GuardContext => ({
  terms: { kind: 'ok', rules: parseTerms(`${TERM}\n`) },
  cwd: '/work',
  env: { HOME: '/srv/agent' },
  protectedPaths: [],
  readFile: () => undefined,
  readAlias: () => undefined,
  readIncludedHooksPath: () => false,
  readGhAliases: aliases(table),
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
    `gh alias set -s=true zz 'git push --no-verify'`,
    `gh alias set -s=T zz 'git push --no-verify'`,
    `gh alias set -ss zz 'git push --no-verify'`,
    `gh alias set --shell=1 zz 'git push --no-verify'`,
    `gh alias set zz 'git push --no-verify' --shell`,
    `gh alias set --clobber=true -s zz 'git push --no-verify'`,
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

  it.each([
    `gh alias set x "$BODY"`,
    `gh alias "$VERB" x 'pr list'`,
    `gh "$VERB" x 'pr list'`,
    `gh alias set -x zz 'git status'`,
    `gh alias set --shel zz 'git status'`,
    `gh alias set -s=maybe zz 'git status'`,
    `gh -R o/r alias set zz 'git status'`,
  ])('denies an alias definition with a word the guard cannot resolve: %s', command => {
    expectDeny(checkCommand(command, ctx()), REASONS.ghAliasHidden)
  })

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

  it.each([
    ['gh -R o/r rx --no-verify', 'git push origin $3'],
    ['gh --repo o/r rx --no-verify', 'git push origin $3'],
    ['gh --repo=o/r rx --no-verify', 'git push origin $2'],
    ['gh -Ro/r rx --no-verify', 'git push origin $2'],
    ['gh --help rx --no-verify', 'git push origin $2'],
    ['gh --version rx --no-verify', 'git push origin $2'],
    ['gh --foo bar rx --no-verify', 'git push origin $3'],
    ['gh -xyz rx --no-verify', 'git push origin $2'],
  ])('finds an alias behind gh flags and passes the flags on: %s', (command, body) => {
    expectDeny(checkCommand(command, ctx({ rx: { shell: true, body } })), REASONS.noVerify)
  })

  it.each(['gh -h rx --no-verify', 'gh -- rx --no-verify'])(
    'does not run the alias where gh reads another command word: %s',
    command => {
      const table = { rx: { shell: true, body: 'git push origin $1' } }
      expect(checkCommand(command, ctx(table))).toBeUndefined()
    },
  )

  it.each(['co', 'help', '__complete', '__completeNoDesc'])(
    'follows a config alias that shadows the gh word %s',
    word => {
      expectDeny(checkCommand(`gh ${word}`, ctx({ [word]: NO_VERIFY_SHELL })), REASONS.noVerify)
    },
  )

  it('denies an unresolved command word under a gh group that has config aliases', () => {
    expectDeny(checkCommand('gh issue "$W"', ctx({ 'issue mine': NO_VERIFY_SHELL })), REASONS.ghAliasHidden)
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
    'GH_CONFIG_DIR=/tmp/x gh repo view',
    'gh pv 7',
    'gh -R o/r pr view 1',
    'gh repo "$W"',
    'gh api "repos/o/r/commits/$SHA/check-runs"',
  ])('allows %s', command => {
    const table = { co: { shell: false, body: 'pr checkout' }, pv: { shell: false, body: 'pr view' } }
    expect(checkCommand(command, ctx(table))).toBeUndefined()
  })
})

describe('a shell alias argument inside double quotes (TP-2371 review)', () => {
  it.each([
    ['y', '"$@"', 'gh y git push --no-verify'],
    ['e', 'git "$@"', 'gh e push --no-verify'],
    ['c', 'eval "$*"', `gh c 'git push --no-verify'`],
    ['d', 'sh -c "$1"', `gh d 'git push --no-verify'`],
  ])('denies gh alias %s = %s run as %s', (name, body, command) => {
    expectDeny(checkCommand(command, ctx({ [name]: { shell: true, body } })), REASONS.ghAliasHidden)
  })

  it.each([`gh alias set --shell y '"$@"'`, `gh alias set --shell co 'gh pr checkout "$1"'`])(
    'denies setting a shell alias that reads a positional inside double quotes: %s',
    command => {
      expectDeny(checkCommand(command, ctx()), REASONS.ghAliasHidden)
    },
  )

  it.each([
    ['e', '!git "$@"', 'git e push --no-verify'],
    ['y', '!"$@"', 'git y git push --no-verify'],
  ])('denies git alias %s = %s run as %s', (name, value, command) => {
    const readAlias = (word: string) => (word === name ? { value, runsIn: '/work' } : undefined)
    expectDeny(checkCommand(command, { ...ctx(), readAlias }), REASONS.aliasQuotedArgs)
  })

  it.each(['gh co 12', 'gh co'])('allows %s through a stored "$1" alias with a plain argument', command => {
    expect(checkCommand(command, ctx({ co: { shell: true, body: 'gh pr checkout "$1"' } }))).toBeUndefined()
  })

  it('reads every positional outside single quotes, with its quoting and modifier', () => {
    const body = `"$1" '"$2"' "\\$3" "\${@}" $4 "a'$*'" "\${1:-x}" \${#1} $'\\''"$5"`
    expect(positionalUses(body).map(use => [use.name, use.quoted, use.modified])).toEqual([
      ['1', true, false],
      ['@', true, false],
      ['4', false, false],
      ['*', true, false],
      ['1', true, true],
      ['1', false, true],
      ['5', true, false],
    ])
  })

  it.each([
    `gh alias set --shell y 'git push "\${1:-x}"'`,
    `gh alias set --shell y 'git push "\${@:1}"'`,
    `gh alias set --shell y 'git push "\${1#x}"'`,
    `gh alias set --shell y 'git push \${!1}'`,
  ])('denies setting a shell alias that reads a positional with a modifier: %s', command => {
    expectDeny(checkCommand(command, ctx()), REASONS.ghAliasHidden)
  })

  it.each(['git push "${1:-x}"', 'git push "${@:1}"', 'git push "${1#x}"'])(
    'denies running a stored shell alias %s, whose modifier the guard does not fill',
    body => {
      expectDeny(checkCommand('gh y --no-verify', ctx({ y: { shell: true, body } })), REASONS.ghAliasHidden)
    },
  )

  it.each([
    ['git $1', `gh y 'push --no-verify'`],
    ['git $@', `gh y 'push --no-verify'`],
    ['git $*', `gh y 'push --no-verify'`],
    [`x=$'\\''; eval "$1"`, `gh y 'git push --no-verify'`],
  ])('denies gh alias %s run with an argument that is not a plain word: %s', (body, command) => {
    expectDeny(checkCommand(command, ctx({ y: { shell: true, body } })), REASONS.ghAliasHidden)
  })

  it('denies a git ! alias with an unquoted positional fed an argument with spaces', () => {
    const readAlias = (word: string) => (word === 'y' ? { value: '!git $1', runsIn: '/work' } : undefined)
    expectDeny(checkCommand(`git y 'push --no-verify'`, { ...ctx(), readAlias }), REASONS.aliasQuotedArgs)
  })

  it('denies a quoted "$@" given no argument, which fills one empty word', () => {
    expectDeny(
      checkCommand('gh y', ctx({ y: { shell: true, body: 'git push "$@"' } })),
      REASONS.ghAliasHidden,
    )
  })

  it.each([
    ['git push origin $1', 'gh y main'],
    ['git log $@', 'gh y -1 --oneline'],
  ])('allows gh alias %s run with plain words: %s', (body, command) => {
    expect(checkCommand(command, ctx({ y: { shell: true, body } }))).toBeUndefined()
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

describe('a gh extension and the clone passthrough (TP-2371)', () => {
  it.each([
    `gh repo clone o/r -- -c core.pager='git push --no-verify'`,
    `gh repo clone o/r d -- -c core.pager='git push --no-verify'`,
    `gh repo clone o/r -- d -c core.pager='git push --no-verify'`,
    `gh repo clone -u up o/r -- -c core.pager='git push --no-verify'`,
    `gh repo fork o/r --clone -- -c core.sshCommand='git push --no-verify'`,
    `gh repo fork --remote-name x o/r --clone -- --config core.pager='git push --no-verify'`,
    `gh repo clone o/r -- 'ext::sh -c git% push% --no-verify'`,
    `agent-chat gh-write -- repo clone o/r -- -c core.pager='git push --no-verify'`,
  ])('denies a git clone flag that skips the pre-push scan: %s', command => {
    expectDeny(checkCommand(command, ctx()), REASONS.noVerify)
  })

  it.each([
    `gh repo clone o/r -- "$OPTS"`,
    `gh repo clone o/r "$D" -- "$OPTS"`,
    `gh repo fork o/r --clone -- --depth "$N"`,
  ])(
    'denies a word after -- the guard cannot resolve, which git clone may read as an option: %s',
    command => {
      expectDeny(checkCommand(command, ctx()), REASONS.ghCloneHidden)
    },
  )

  it('checks the words after a hidden word that may be --', () => {
    const command = `gh repo clone o/r "$D" -c core.pager='git push --no-verify'`
    expectDeny(checkCommand(command, ctx()), REASONS.noVerify)
  })

  it.each([
    'gh myext',
    'gh myext --no-verify',
    'gh -R o/r myext',
    'gh extension exec myext',
    'gh ext exec myext',
    'gh extension "$SUB" myext',
  ])('denies running a gh extension: %s', command => {
    expectDeny(checkCommand(command, ctx()), REASONS.ghExtension)
  })

  it.each([
    `gh repo clone "$R" -- -c core.sshCommand='git push --no-verify'`,
    `gh repo clone "$R" -- --upload-pack='git push --no-verify'`,
    `gh repo clone "$R" -- --config=core.sshCommand='git push --no-verify'`,
    `gh repo clone "$R" d -- -u 'git push --no-verify'`,
    `gh repo fork "$R" --clone -- -c core.sshCommand='git push --no-verify'`,
    `gh repo "$S" o/r -- -c core.sshCommand='git push --no-verify'`,
    `gh -R x/y repo "$S" o/r -- -c core.sshCommand='git push --no-verify'`,
  ])("strips gh's -- after a repository the guard cannot resolve (review r1): %s", command => {
    expectDeny(checkCommand(command, ctx()), REASONS.noVerify)
  })

  it.each([`gh repo clone "$R" "$D" -- "$OPTS"`, `gh repo clone o/r "$X" "$Y"`, `gh repo clone "$R" d "$Y"`])(
    'denies an unresolved word that may sit past a hidden --: %s',
    command => {
      expectDeny(checkCommand(command, ctx()), REASONS.ghCloneHidden)
    },
  )

  it.each([
    'gh help myext',
    'gh help myext extra words',
    'gh help -R o/r myext',
    'gh -R o/r help myext',
    'gh help "$E"',
  ])('denies gh help on a word that is no gh command, which runs the extension (review r1): %s', command => {
    expectDeny(checkCommand(command, ctx()), REASONS.ghExtension)
  })

  it('denies an extension with no gh config to read', () => {
    const { readGhAliases: _, ...bare } = ctx()
    expectDeny(checkCommand('gh myext', bare), REASONS.ghExtension)
  })

  it('runs a config alias before an extension of the same name', () => {
    expect(checkCommand('gh myext', ctx({ myext: { shell: false, body: 'pr list' } }))).toBeUndefined()
  })

  it.each([
    'gh repo clone o/r',
    'gh repo clone o/r d',
    'gh repo clone o/r -- --depth 1',
    'gh repo clone o/r d -- -c core.pager=less',
    'gh repo fork o/r --clone',
    'gh repo clone "$REPO"',
    'gh repo clone o/r "$DIR"',
    'gh extension list',
    'gh extension install o/gh-x',
    'gh help',
    'gh help pr view',
    'gh help environment',
    'gh repo clone "$R" "$D"',
    'gh repo clone -- o/r',
    'gh telemetry',
    'gh pr nosuchword',
  ])('allows %s', command => {
    expect(checkCommand(command, ctx())).toBeUndefined()
  })

  it('hands git clone each word after the repository, in order', () => {
    expect(ghCloneArgs(['o/r', 'd', '--', '--depth', '1'])).toEqual({ git: [1, 3, 4], hidden: false })
    expect(ghCloneArgs(['-u', 'up', 'o/r', '--no-upstream'])).toEqual({ git: [], hidden: false })
    expect(ghCloneArgs(['o/r', undefined, '-c', 'x'])).toEqual({ git: [1, 2, 3], hidden: false })
    expect(ghCloneArgs([undefined, '--', '-c', 'x'])).toEqual({ git: [2, 3], hidden: false })
    expect(ghCloneArgs(['--', 'o/r', '-c'])).toEqual({ git: [2], hidden: false })
  })

  const gh = process.env.CI ? undefined : spawnSync('gh', ['help'], { encoding: 'utf8' })
  it.skipIf(gh?.status !== 0)('knows every command gh help lists, on the machine gh', () => {
    const sections = (gh?.stdout ?? '').split(/\n(?=[A-Z][A-Z ]+\n)/)
    const listed = sections
      .filter(section => !/^(ALIAS|EXTENSION) COMMANDS/.test(section))
      .flatMap(section => [...section.matchAll(/^ {2}([a-z][\w-]*):/gm)].map(match => match[1]))
    expect(listed.length).toBeGreaterThan(20)
    expect(listed.filter(name => !GH_BUILTINS.has(name as string))).toEqual([])
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

  const read = (env: Record<string, string>) => {
    const config = ghAliasReader(env, readText)()
    return (name: string): GhAlias | undefined =>
      config.kind === 'ok' ? config.aliases.get(name) : undefined
  }

  it('reads shell and plain aliases from GH_CONFIG_DIR', () => {
    const lookup = read({ GH_CONFIG_DIR: scratch(CONFIG) })
    expect(lookup('co')).toEqual({ shell: false, body: 'pr checkout' })
    expect(lookup('rx')).toEqual({ shell: true, body: 'git push $1' })
    expect(lookup('constructor')).toBeUndefined()
  })

  it('reads from XDG_CONFIG_HOME/gh, then ~/.config/gh', () => {
    const xdg = scratch(undefined)
    fs.mkdirSync(path.join(xdg, 'gh'))
    fs.writeFileSync(path.join(xdg, 'gh', 'config.yml'), CONFIG)
    expect(read({ XDG_CONFIG_HOME: xdg })('co')?.body).toBe('pr checkout')
    const home = scratch(undefined)
    fs.mkdirSync(path.join(home, '.config', 'gh'), { recursive: true })
    fs.writeFileSync(path.join(home, '.config', 'gh', 'config.yml'), CONFIG)
    expect(read({ HOME: home })('co')?.body).toBe('pr checkout')
  })

  it('keeps the first of duplicate keys, as gh does', () => {
    const dup = `x: 1\nx: 2\naliases:\n    d: '!echo FIRST'\n    d: '!echo SECOND'\naliases:\n    e: pr list\n`
    const config = parseGhAliases(dup)
    expect(config.kind === 'ok' && [...config.aliases]).toEqual([['d', { shell: true, body: 'echo FIRST' }]])
  })

  it.each([
    ['an empty file', ''],
    ['no aliases key', 'version: 1\n'],
    ['an empty aliases key', 'aliases:\n'],
  ])('reads no alias from %s', (_, config) => {
    expect(parseGhAliases(config)).toEqual({ kind: 'ok', aliases: new Map() })
  })

  it.each([
    ['malformed yaml', 'aliases: [unclosed\n'],
    ['aliases that are not a map', 'aliases: 3\n'],
    ['an alias that is not a string', 'aliases:\n    d: [a, b]\n'],
    ['a document that is not a map', '- a\n'],
  ])('reads %s as unreadable, without throwing', (_, config) => {
    expect(parseGhAliases(config)).toEqual({ kind: 'unreadable' })
  })
})

describe('gh command words and alias set flags', () => {
  it('finds command words the way cobra strips flags', () => {
    expect(ghCommandWords(['-R', 'o/r', 'pr', 'view', '1'], 2)).toEqual([2, 3])
    expect(ghCommandWords(['--repo=x', '-xyz', 'rx'], 2)).toEqual([2])
    expect(ghCommandWords(['-h', 'pv', 'a'], 2)).toEqual([2])
    expect(ghCommandWords(['--', 'pv'], 2)).toEqual([])
    expect(ghCommandWords(['pr', undefined], 2)).toEqual([0, HIDDEN])
  })

  it('reads -sh as help, which stores nothing', () => {
    expect(ghAliasSet(['-sh', 'zz', 'git status'])).toBeUndefined()
  })

  it('reads --shell=false as a plain alias', () => {
    expect(ghAliasSet(['--shell=false', 'zz', 'pr list'])).toEqual({
      kind: 'body',
      alias: { shell: false, body: 'pr list' },
    })
  })
})

describe('the hook on a real gh config (TP-2371 review)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })
  const decide = (config: string, command: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-alias-hook-'))
    dirs.push(dir)
    fs.writeFileSync(path.join(dir, 'config.yml'), config)
    const event = JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: '/work' })
    return pretoolDecision(event, cwd =>
      guardContext({ GH_CONFIG_DIR: dir, PATH: '' }, cwd, '/nonexistent-home'),
    )
  }
  const deny = (reason: string): string => {
    expect(reason).toBeDefined()
    return denyOutput(reason)
  }

  it.each([
    [
      'a global flag before the alias',
      `aliases:\n    rx: '!git push origin $3'\n`,
      'gh -R o/r rx --no-verify',
    ],
    ['--repo= before the alias', `aliases:\n    rx: '!git push origin $2'\n`, 'gh --repo=x rx --no-verify'],
    ['--help before the alias', `aliases:\n    rx: '!git push origin $2'\n`, 'gh --help rx --no-verify'],
    ['a co alias in config', `aliases:\n    co: '!git push --no-verify'\n`, 'gh co'],
  ])('denies %s', (_, config, command) => {
    expect(decide(config, command)).toBe(deny(REASONS.noVerify))
  })

  it('reads the first of duplicate alias keys', () => {
    const config = `aliases:\n    pv: '!git push --no-verify'\n    pv: pr view\n`
    expect(decide(config, 'gh pv')).toBe(deny(REASONS.noVerify))
  })

  it('denies an alias lookup when config.yml does not parse', () => {
    expect(decide('aliases: [unclosed\n', 'gh pv')).toBe(deny(REASONS.ghAliasUnreadable))
    expect(decide('aliases: [unclosed\n', 'gh pr mine')).toBe(deny(REASONS.ghAliasUnreadable))
  })

  it.each([`gh alias set -s=true zz 'git push --no-verify'`, `gh alias set -ss zz 'git push --no-verify'`])(
    'denies the set-time flag form %s',
    command => {
      expect(decide('version: 1\n', command)).toBe(deny(REASONS.noVerify))
    },
  )

  it.each([
    'export GH_CONFIG_DIR=/tmp/evil; gh pr mine',
    'GH_CONFIG_DIR=/tmp/evil gh pr mine',
    'XDG_CONFIG_HOME=/tmp/evil gh pr mine',
    'env HOME=/tmp/evil gh pr mine',
    'GH_CONFIG_DIR=/tmp/evil gh -R o/r pr mine',
    'GH_CONFIG_DIR=/tmp/evil gh pr -R o/r mine',
    'GH_CONFIG_DIR=/tmp/evil gh actions mine',
    'GH_CONFIG_DIR=/tmp/evil gh pr "$W"',
  ])('denies a group alias that may be read from another config: %s', command => {
    expect(decide('version: 1\n', command)).toBe(deny(REASONS.ghAliasEnv))
  })

  it('denies a group alias on a line that writes gh config', () => {
    const command = `printf 'aliases:\\n    pr mine: x\\n' > /tmp/evil/config.yml; gh pr mine`
    expect(decide('version: 1\n', command)).toBe(deny(REASONS.ghAliasWritten))
  })

  it('denies a group alias the hook config holds', () => {
    const config = `aliases:\n    pr mine: '!git push --no-verify'\n`
    expect(decide(config, 'gh pr mine')).toBe(deny(REASONS.noVerify))
    expect(decide(config, 'gh -R o/r pr mine')).toBe(deny(REASONS.noVerify))
  })

  it.each([
    'GH_CONFIG_DIR=/tmp/x gh repo view',
    'GH_CONFIG_DIR=/tmp/x gh pr ls',
    'GH_CONFIG_DIR=/tmp/x gh pr co 12',
    'GH_CONFIG_DIR=/tmp/x gh status',
    'GH_CONFIG_DIR=/tmp/x gh browse zz',
    'cat config.yml; gh status zz',
  ])('allows a real subcommand, or a command with no alias children, under another config: %s', command => {
    expect(decide('version: 1\n', command)).toBe('')
  })

  it('runs a real subcommand before a config alias of the same name, as gh does', () => {
    expect(decide(`aliases:\n    pr list: '!git push --no-verify'\n`, 'gh pr list')).toBe('')
  })

  it.each([
    ['cs one', 'gh codespace one'],
    ['codespace two', 'gh cs two'],
    ['repo deploy-key four', 'gh repo -R o/r deploy-key four'],
    ['ext five', 'gh extensions five'],
    ['extension six', 'gh ext six'],
    ['at seven', 'gh attestation seven'],
    ['ruleset eight', 'gh rs eight'],
    ['skills nine', 'gh skill nine'],
    ['agents ten', 'gh agent-task ten'],
    ['repo  autolink   eleven', 'gh repo autolink eleven'],
  ])('reads config key %s on the canonical path gh runs it from: %s', (key, command) => {
    const config = `aliases:\n    ${key}: '!git push --no-verify'\n`
    expect(decide(config, command)).toBe(deny(REASONS.noVerify))
  })

  it('checks every key that names one alias path', () => {
    const config = `aliases:\n    codespace one: pr list\n    cs one: '!git push --no-verify'\n`
    expect(decide(config, 'gh codespace one')).toBe(deny(REASONS.noVerify))
  })

  it.each([
    ['pr mine extra', 'gh pr mine'],
    ['pr view seven', 'gh pr view seven'],
    ['codespace ports nine', 'gh cs ports nine'],
    ['accessibility twelve', 'gh a11y twelve'],
    ['repo deploy-key list eight', 'gh repo deploy-key list eight'],
    ['repo deploy-key list', 'gh repo deploy-key list'],
  ])('allows config key %s, which gh never runs, on %s', (key, command) => {
    expect(decide(`aliases:\n    ${key}: '!git push --no-verify'\n`, command)).toBe('')
  })

  it('denies a nested alias that may be read from another config', () => {
    expect(decide('version: 1\n', 'GH_CONFIG_DIR=/tmp/evil gh repo deploy-key four')).toBe(
      deny(REASONS.ghAliasEnv),
    )
  })

  it.each([
    'GH_CONFIG_DIR=/tmp/x gh repo deploy-key list',
    'GH_CONFIG_DIR=/tmp/x gh auth git-credential get',
  ])('allows a real nested subcommand under another config: %s', command => {
    expect(decide('version: 1\n', command)).toBe('')
  })

  const SPACED_KEYS = [
    ['quoted', `aliases:\n    "'pr x'": '!git push --no-verify'\n`],
    ['backslash-escaped', `aliases:\n    pr\\ x: '!git push --no-verify'\n`],
  ]
  const TAKEN_OVER = ['gh pr checkout 1', 'gh pr view 1', 'gh issue list', 'gh api user', 'gh git']

  it.each(SPACED_KEYS.flatMap(([form, config]) => TAKEN_OVER.map(command => [form, command, config])))(
    'denies, under a %s alias name that holds a space, %s',
    (_, command, config) => {
      expect(decide(config as string, command as string)).toBe(deny(REASONS.ghAliasUnreadable))
    },
  )

  it.each([
    `gh alias set "'pr x'" '!git push --no-verify'`,
    `gh alias set 'pr\\ x' 'pr list'`,
    `gh alias set -s '"issue y"' 'echo hi'`,
  ])('denies setting an alias whose name holds a quoted or escaped space: %s', command => {
    expect(decide('version: 1\n', command)).toBe(deny(REASONS.ghAliasUnreadable))
  })

  it('allows a two-word group alias name, which gh splits into a path', () => {
    expect(decide('version: 1\n', `gh alias set 'pr mine' 'pr list --author @me'`)).toBe('')
  })

  const EXOTIC = [
    ['NBSP', ' ', '\\u00a0'],
    ['VT', '\u000b', '\\v'],
    ['FF', '\u000c', '\\f'],
    ['U+2003', ' ', '\\u2003'],
    ['U+3000', '　', '\\u3000'],
    ['zero-width space', '​', '\\u200b'],
  ]

  it.each(EXOTIC)('denies a gh command under a stored alias name holding %s', (_, __, yamlEscape) => {
    const config = `aliases:\n    "pr${yamlEscape}x": '!git push --no-verify'\n`
    expect(decide(config, 'gh pr view 1')).toBe(deny(REASONS.ghAliasUnreadable))
  })

  it.each(EXOTIC)('denies setting an alias name holding %s', (_, char) => {
    expect(decide('version: 1\n', `gh alias set 'pr${char}x' 'pr list'`)).toBe(
      deny(REASONS.ghAliasUnreadable),
    )
  })

  it('denies a newline inside a quoted alias name, stored and at set time', () => {
    const config = `aliases:\n    "'pr\\nx'": '!git push --no-verify'\n`
    expect(decide(config, 'gh pr view 1')).toBe(deny(REASONS.ghAliasUnreadable))
    expect(decide('version: 1\n', `gh alias set "'pr\nx'" 'pr list'`)).toBe(deny(REASONS.ghAliasUnreadable))
  })

  it.each(['gh pr view 1', 'gh co 12', 'gh api user', `gh alias set mine 'pr list --author @me'`])(
    'allows %s on the default config',
    command => {
      expect(decide(`version: 1\naliases:\n    co: pr checkout\n`, command)).toBe('')
    },
  )

  it.each([
    ['zz #c', 'gh zz'],
    ['pr mine #c', 'gh pr mine'],
  ])('denies a stored alias name %s, which gh reads up to its # comment, on %s', (key, command) => {
    const config = `aliases:\n    "${key}": '!git push --no-verify'\n`
    expect(decide(config, command)).toBe(deny(REASONS.ghAliasUnreadable))
  })

  it.each([`gh alias set 'zz #c' 'pr list'`, `gh alias set 'pr mine #c' 'pr list'`])(
    'denies setting an alias name with a # comment: %s',
    command => {
      expect(decide('version: 1\n', command)).toBe(deny(REASONS.ghAliasUnreadable))
    },
  )

  it('denies setting an alias through gh-write whose body skips the pre-push scan', () => {
    const command = `agent-chat gh-write -- alias set 'repo pv' '!git push --no-verify'`
    expect(decide('version: 1\n', command)).toBe(deny(REASONS.noVerify))
  })

  it.each(['agent-chat gh-write -- repo pv', 'agent-chat gh-write -- -R o/r repo pv 1'])(
    'denies running a stored group alias through gh-write: %s',
    command => {
      const config = `aliases:\n    repo pv: '!git push --no-verify'\n`
      expect(decide(config, command)).toBe(deny(REASONS.noVerify))
    },
  )

  it.each([
    'agent-chat gh-write zz -- 1',
    'agent-chat gh-write pr -- mine',
    'agent-chat gh-write pr mine -- 1',
  ])('reads gh-write args the way commander does, keeping words before --: %s', command => {
    const config = `aliases:\n    zz: '!git push --no-verify'\n    pr mine: '!git push --no-verify'\n`
    expect(decide(config, command)).toBe(deny(REASONS.noVerify))
  })

  it('denies a gh-write group alias that may be read from another config', () => {
    const command = 'GH_CONFIG_DIR=/tmp/evil agent-chat gh-write -- repo pv'
    expect(decide('version: 1\n', command)).toBe(deny(REASONS.ghAliasEnv))
  })

  it.each(['agent-chat gh-write -- pr checkout 1', 'agent-chat gh-write -- repo view o/r'])(
    'allows %s on the default config',
    command => {
      expect(decide(`aliases:\n    co: pr checkout\n`, command)).toBe('')
    },
  )

  it.each([
    '. /tmp/rc; gh zz',
    'source /tmp/rc && gh pr mine',
    'export GH_CONFIG_DIR=/tmp/e; gh zz',
    'unset GH_CONFIG_DIR; gh zz',
    '. /tmp/rc; agent-chat gh-write -- repo pv',
  ])('denies an alias word once the scope may point gh at another config: %s', command => {
    expect(decide('version: 1\n', command)).toBe(deny(REASONS.ghAliasEnv))
  })

  it.each([
    'mv /tmp/evilgh ~/.config/gh && gh zz',
    'cp -r /tmp/evilgh/. ~/.config/gh/ && gh zz',
    'ln -sfn /tmp/evilgh ~/.config/gh; gh zz',
    'tar -xf e.tar -C ~/.config/gh; gh zz',
    'mv /tmp/evilgh ~/.config/gh && gh pr mine',
    'mv /tmp/evilgh "$XDG_CONFIG_HOME/gh"; gh zz',
    'cp -r /tmp/evilgh/. "$GH_CONFIG_DIR"; gh zz',
  ])('denies an alias word on a line that writes the gh config directory: %s', command => {
    expect(decide('version: 1\n', command)).toBe(deny(REASONS.ghAliasWritten))
  })

  it.each([
    'source ./env.sh && gh pr view 1',
    'cd "$HOME/src" && gh co 12',
    'ls ~/.config/ghostty; gh co 12',
  ])('allows %s, which cannot run an alias from another config', command => {
    expect(decide(`aliases:\n    co: pr checkout\n`, command)).toBe('')
  })

  it('allows gh co on the default config', () => {
    expect(decide(`aliases:\n    co: pr checkout\n`, 'gh co 12')).toBe('')
  })
})
