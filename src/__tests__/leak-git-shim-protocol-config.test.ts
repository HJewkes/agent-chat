import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { type GitShimFixture as Fixture, gitShimHarness } from './helpers/git-shim-fixture.js'

/**
 * CC-1336 / CC-1607, against real git: the shim no longer exports a protocol list the caller did
 * not set, so git ranks the caller's own protocol config, and a last `protocol.ext.allow=never`
 * config pair keeps `ext::` off (CC-1095). Rows name the table in the CC-1336 plan. Fixtures from
 * the ac#1160 branch (f1015ed0, 550c03c8, 406a983a, 3c2d5432).
 */

const harness = gitShimHarness()
const { git, runScript } = harness

const LEGACY = 'GIT_ALLOW_PROTOCOL=file:git:http:https:ssh'
const DENY_ALL = '[protocol]\n\tallow = never\n'
const DENY_SSH = '[protocol "ssh"]\n\tallow = never\n'
const root = (fx: Fixture, ...parts: string[]): string => path.join(fx.work, '..', ...parts)
const homeConfig = (fx: Fixture): string => root(fx, 'home', '.gitconfig')
const sshMarker = (fx: Fixture): string => root(fx, 'ssh-ran')

/** An ls-remote over ssh whose core.sshCommand leaves a marker, so the marker shows the transport ran. */
const sshCommand = (fx: Fixture, prefix: string, configs: string, subcommand = 'ls-remote'): string =>
  `${prefix} env -u GIT_SSH_COMMAND git -c 'core.sshCommand=touch ${sshMarker(fx)}; false' ${configs} ${subcommand} ssh://x.invalid/r`

/** The same probe as a clone into ../cloned, with `options` after the subcommand. */
const cloneCommand = (fx: Fixture, prefix: string, options: string): string =>
  `${sshCommand(fx, prefix, '', `clone -q ${options}`)} ../cloned`

function expectSsh(fx: Fixture, command: string, ran: boolean): void {
  const run = runScript(fx, command)

  expect(run.stderr.includes("transport 'ssh' not allowed")).toBe(!ran)
  expect(fs.existsSync(sshMarker(fx))).toBe(ran)
}

describe("the pin under a caller's command-line protocol config (rows 1, 2, 16, 17, 20)", () => {
  it.each([
    ['protocol.allow=never, list unset', 'env -u GIT_ALLOW_PROTOCOL', '-c protocol.allow=never', false],
    // Kills: exporting the legacy list a live agent's env already carries.
    ['protocol.allow=never, legacy list', LEGACY, '-c protocol.allow=never', false],
    ['protocol.ssh.allow=never, legacy list', LEGACY, '-c protocol.ssh.allow=never', false],
    ['a caller list of https alone', 'GIT_ALLOW_PROTOCOL=https', '', false],
    ['no config, list unset', 'env -u GIT_ALLOW_PROTOCOL', '', true],
    ['no config, legacy list', LEGACY, '', true],
  ])('under %s, ssh runs: %s', (_label, prefix, configs, ran) => {
    const fx = harness.fixture()

    expectSsh(fx, sshCommand(fx, prefix, configs), ran)
  })
})

const includeIf = (condition: string): string => `[includeIf "${condition}"]\n\tpath = deny.inc\n`

/**
 * A clone into ../cloned from a cwd repo that allows ssh, under a global config and a template at
 * ../tpl named by `via`; deny.inc sits beside the global config and deny.cfg beside ../cloned.
 */
function cloneUnder(fx: Fixture, global: string, template: string, via: 'option' | 'env' | ''): string {
  const dir = root(fx, 'tpl')
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'config'), template)
  fs.writeFileSync(homeConfig(fx), global)
  fs.writeFileSync(root(fx, 'home', 'deny.inc'), DENY_ALL)
  fs.writeFileSync(root(fx, 'deny.cfg'), DENY_SSH)
  git(fx.work, 'config', 'protocol.ssh.allow', 'always')
  return cloneCommand(
    fx,
    via === 'env' ? `GIT_TEMPLATE_DIR='${dir}'` : '',
    via === 'option' ? `--template='${dir}'` : '',
  )
}

describe('the pin under config a clone creates (rows 3-6)', () => {
  it.each([
    ['a global deny', DENY_ALL, '', ''],
    ['a global includeIf gitdir:', includeIf('gitdir:**/cloned/'), '', ''],
    ['a global includeIf hasconfig:', includeIf('hasconfig:remote.*.url:ssh://x.invalid/**'), '', ''],
    ['a global init.templateDir', '[init]\n\ttemplateDir = ~/../tpl\n', DENY_SSH, ''],
    ['--template=<dir>', '', DENY_SSH, 'option'],
    ['GIT_TEMPLATE_DIR', '', DENY_SSH, 'env'],
    // A relative include in the copied config resolves beside the new git dir, not the template.
    ['a template including ../../deny.cfg', '', '[include]\n\tpath = ../../deny.cfg\n', 'option'],
  ] as const)('keeps ssh denied for a clone under %s', (_label, global, template, via) => {
    const fx = harness.fixture()

    expectSsh(fx, cloneUnder(fx, global, template, via), false)
  })

  it('lets a clone run ssh under a template that allows it', () => {
    const fx = harness.fixture()

    expectSsh(fx, cloneUnder(fx, '', '[protocol "ssh"]\n\tallow = always\n', 'option'), true)
  })
})

/** Adds a clone of the work tree as submodule `sub`, whose origin is `url`; returns its work tree. */
function withSubmodule(fx: Fixture, work = fx.work, url = 'ssh://x.invalid/sub'): string {
  const source = root(fx, 'sub-source')
  if (!fs.existsSync(source)) git(root(fx), 'clone', '-q', fx.work, source)
  git(work, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'sub')
  const sub = path.join(work, 'sub')
  git(sub, 'config', 'remote.origin.url', url)
  return sub
}

/** A submodule in a linked worktree at ../wt; returns its work tree. */
function worktreeSubmodule(fx: Fixture): string {
  const wt = root(fx, 'wt')
  git(fx.work, 'worktree', 'add', '-q', wt)
  return withSubmodule(fx, wt)
}

/** A submodule whose gitfile points at a git dir outside `modules`; returns its work tree. */
function outsideGitdirSubmodule(fx: Fixture): string {
  const sub = withSubmodule(fx)
  const outside = root(fx, 'outside.git')
  fs.renameSync(path.join(fx.work, '.git', 'modules', 'sub'), outside)
  fs.writeFileSync(path.join(sub, '.git'), `gitdir: ${outside}\n`)
  git(root(fx), 'config', '--file', path.join(outside, 'config'), 'core.worktree', sub)
  return sub
}

const recursingFetch = (fx: Fixture, cwd = '.'): string =>
  `cd '${cwd}' && ${sshCommand(fx, 'env -u GIT_ALLOW_PROTOCOL', '', 'fetch -q --recurse-submodules=yes').replace(' ssh://x.invalid/r', ' origin')}`

const SUBMODULE_CASES = [
  ['a recursing fetch', withSubmodule, recursingFetch],
  [
    'a recursing fetch in a linked worktree',
    worktreeSubmodule,
    (fx: Fixture) => recursingFetch(fx, root(fx, 'wt')),
  ],
  [
    'submodule update --remote, gitfile outside modules',
    outsideGitdirSubmodule,
    (fx: Fixture) =>
      sshCommand(fx, LEGACY, '', 'submodule update -q --remote').replace(' ssh://x.invalid/r', ''),
  ],
] as const

describe("the pin under a submodule's own config (rows 7-9)", () => {
  it.each(SUBMODULE_CASES)("follows a submodule's own ssh deny, under %s", (_label, make, command) => {
    const denied = harness.fixture()
    git(make(denied), 'config', 'protocol.ssh.allow', 'never')
    const silent = harness.fixture()
    make(silent)

    runScript(denied, command(denied))
    runScript(silent, command(silent))

    expect(fs.existsSync(sshMarker(denied))).toBe(false)
    expect(fs.existsSync(sshMarker(silent))).toBe(true)
  })

  // The pair is command scope, which git keeps for a submodule child (prepare_other_repo_env).
  it('keeps ext denied in a submodule that allows it, which real git without the pair runs', () => {
    const fx = harness.fixture()
    const marker = root(fx, 'ext-ran')
    const sub = withSubmodule(fx, fx.work, `ext::sh -c touch% ${marker}`)
    git(sub, 'config', 'protocol.allow', 'always')
    const fetch = 'fetch -q --recurse-submodules=yes origin'

    runScript(fx, `env -u GIT_ALLOW_PROTOCOL git ${fetch}`)
    const shimmed = fs.existsSync(marker)
    runScript(fx, `env -u GIT_ALLOW_PROTOCOL '${harness.realGit}' ${fetch}`)

    expect(shimmed).toBe(false)
    expect(fs.existsSync(marker)).toBe(true)
  })
})

describe('the pin under a second repo a command starts git in (row 10)', () => {
  it.each([
    ['denies ssh', DENY_SSH, false],
    ['is silent', '', true],
  ])('follows the config of a repo that %s, under rebase -x', (_label, body, ran) => {
    const fx = harness.fixture()
    const other = root(fx, 'other')
    git(root(fx), 'init', '-q', other)
    fs.appendFileSync(path.join(other, '.git', 'config'), body)
    const inner = `cd '${other}' && git ls-remote ssh://x.invalid/r`
    const rebase = sshCommand(fx, LEGACY, '-c user.name=t -c user.email=t@example.com', 'rebase -q --root -x')

    runScript(fx, rebase.replace(' ssh://x.invalid/r', ` "${inner}"`))

    expect(fs.existsSync(sshMarker(fx))).toBe(ran)
  })
})

/** A repo whose remote `x` is an `ext::` command that leaves a marker. */
function extRemote(fx: Fixture): string {
  const marker = root(fx, 'ext-ran')
  git(fx.work, 'remote', 'add', 'x', `ext::sh -c touch% ${marker}`)
  return marker
}

describe('the ext pair (rows 12-14)', () => {
  it.each([
    ['a global protocol.allow=always', '[protocol]\n\tallow = always\n', ''],
    ['a global protocol.ext.allow=always', '[protocol "ext"]\n\tallow = always\n', ''],
    ['-c remote.o.vcs=ext', '', '-c protocol.allow=always -c remote.o.vcs=ext -c remote.o.url=x'],
  ])('keeps ext denied under %s', (_label, global, configs) => {
    const fx = harness.fixture()
    const marker = extRemote(fx)
    fs.writeFileSync(homeConfig(fx), global)

    const run = runScript(fx, `env -u GIT_ALLOW_PROTOCOL git ${configs} fetch ${configs ? 'o' : 'x'}`)

    expect(run.stderr).toContain("transport 'ext' not allowed")
    expect(fs.existsSync(marker)).toBe(false)
  })

  // Kills: trusting the pair when a later command-scope value or include follows it.
  it.each([
    ['-c protocol.ext.allow=always', '', '-c protocol.ext.allow=always'],
    ['--config-env', 'V=always', '--config-env=protocol.ext.allow=V'],
    ['GIT_CONFIG_PARAMETERS', `GIT_CONFIG_PARAMETERS="'protocol.ext.allow'='always'"`, ''],
    ['-c include.path', '', `-c include.path='/cc1607-absent.inc'`],
    ['-c includeIf', '', `-c 'includeIf.gitdir:**/cloned/.path=/cc1607-absent.inc'`],
  ])('refuses under %s', (_label, prefix, configs) => {
    const fx = harness.fixture()
    const marker = extRemote(fx)

    const run = runScript(fx, `${prefix} git ${configs} fetch x`)

    expect(run.stderr).toContain('git-shim: refused (ext-transport)')
    expect(run.status).toBe(2)
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('runs git --version, whose options are not config', () => {
    const run = runScript(harness.fixture(), 'git --version')

    expect(run.stdout).toContain('git version')
  })
})

describe('the GIT_CONFIG_COUNT pair', () => {
  const PAIRS =
    '!printenv GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 GIT_CONFIG_KEY_1 GIT_CONFIG_VALUE_1; true'

  // Kills: writing the pair at index 0 over a caller's, or appending again under a nested shim.
  it.each([
    ['an empty count', 'GIT_CONFIG_COUNT=', '1 protocol.ext.allow never'],
    [
      'a caller pair',
      'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.x GIT_CONFIG_VALUE_0=1',
      '2 core.x 1 protocol.ext.allow never',
    ],
    [
      'the pair already last',
      'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=protocol.ext.allow GIT_CONFIG_VALUE_0=never',
      '1 protocol.ext.allow never',
    ],
  ])('appends protocol.ext.allow=never under %s', (_label, prefix, expected) => {
    const fx = harness.fixture(['pairs'])
    git(fx.work, 'config', 'alias.pairs', PAIRS)

    const run = runScript(fx, `${prefix} git pairs`)

    expect(run.stdout.split('\n').filter(Boolean).join(' ')).toBe(expected)
  })

  it.each([
    ['a count that is not a number', 'GIT_CONFIG_COUNT=x'],
    ['a count past its pairs', 'GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=core.x GIT_CONFIG_VALUE_0=1'],
  ])('refuses %s', (_label, prefix) => {
    const fx = harness.fixture()

    const run = runScript(fx, `${prefix} git status`)

    expect(run.stderr).toContain('git-shim: refused (config-count)')
    expect(run.status).toBe(2)
  })
})
