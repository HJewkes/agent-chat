import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { type GitShimFixture as Fixture, gitShimHarness } from './helpers/git-shim-fixture.js'

/**
 * CC-1095 b, against real git: the agent's git shim pins GIT_ALLOW_PROTOCOL before it runs git,
 * so a repo that allows `ext::` cannot run its command through the shim. Follow-up to Shepherd
 * rv-316 FIX_FIRST on ac#316 at 0122216b. Each test names the shim mutation it kills.
 */

const harness = gitShimHarness()
const { git, runScript } = harness

const CONNECT = `printf 'capabilities\\nconnect git-upload-pack\\n' |`

interface ExtFixture {
  fx: Fixture
  marker: string
}

/** A repo whose config allows `ext::` and whose remote `x` runs a command that leaves a marker. */
function extFixture(shellAliases: readonly string[] = []): ExtFixture {
  const fx = harness.fixture(shellAliases)
  const marker = path.join(fx.work, '..', 'ext-ran')
  git(fx.work, 'config', 'protocol.ext.allow', 'always')
  git(fx.work, 'remote', 'add', 'x', `ext::sh -c touch% ${marker}`)
  return { fx, marker }
}

describe('the agent git shim pinning GIT_ALLOW_PROTOCOL', () => {
  // Kills: the shim exec'ing real git without the pin.
  it.each([
    ['GIT_ALLOW_PROTOCOL=ext', 'GIT_ALLOW_PROTOCOL=ext git fetch x'],
    ['GIT_ALLOW_PROTOCOL=ext:https', 'GIT_ALLOW_PROTOCOL=ext:https git fetch x'],
    // Kills: pinning only when the variable is set.
    ['env -u GIT_ALLOW_PROTOCOL', 'env -u GIT_ALLOW_PROTOCOL git fetch x'],
    ['an empty GIT_ALLOW_PROTOCOL', 'GIT_ALLOW_PROTOCOL= git fetch x'],
  ])('refuses an ext:: fetch under %s and never runs its command', (_label, command) => {
    const { fx, marker } = extFixture()

    const run = runScript(fx, command)

    expect(run.stderr).toContain("transport 'ext' not allowed")
    expect(run.status).not.toBe(0)
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('refuses a remote made ext by -c remote.<name>.vcs=ext', () => {
    const { fx, marker } = extFixture()

    const run = runScript(
      fx,
      `GIT_ALLOW_PROTOCOL=ext git -c protocol.allow=always -c remote.o.vcs=ext -c 'remote.o.url=sh -c touch% ${marker}' fetch o`,
    )

    expect(run.stderr).toContain("transport 'ext' not allowed")
    expect(fs.existsSync(marker)).toBe(false)
  })

  // Kills: no remote-ext arm in resolve.
  it('refuses git remote-ext, which skips the transport check', () => {
    const { fx, marker } = extFixture()

    const run = runScript(fx, `${CONNECT} git remote-ext o 'sh -c touch% ${marker}'`)

    expect(run.stderr).toContain('git-shim: refused (ext-transport)')
    expect(run.status).toBe(2)
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('refuses an alias that expands to remote-ext', () => {
    const { fx, marker } = extFixture()
    git(fx.work, 'config', 'alias.rx', 'remote-ext')

    const run = runScript(fx, `${CONNECT} git rx o 'sh -c touch% ${marker}'`)

    expect(run.stderr).toContain('git-shim: refused (ext-transport)')
    expect(fs.existsSync(marker)).toBe(false)
  })

  // Kills: returning the safe list when the caller's is narrower.
  it("keeps a caller's narrower list, so a local fetch fails under https alone", () => {
    const { fx } = extFixture()

    const run = runScript(fx, `GIT_ALLOW_PROTOCOL=https git fetch -q '${fx.remote}'`)

    expect(run.stderr).toContain("transport 'file' not allowed")
    expect(run.status).not.toBe(0)
  })

  it('lets a local remote through when the variable is unset', () => {
    const { fx } = extFixture()

    const run = runScript(fx, `env -u GIT_ALLOW_PROTOCOL git ls-remote '${fx.remote}'`)

    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
  })

  it('hands git the pinned list', () => {
    const { fx } = extFixture(['env'])
    git(fx.work, 'config', 'alias.env', '!printenv GIT_ALLOW_PROTOCOL')

    const run = runScript(fx, 'GIT_ALLOW_PROTOCOL=EXT:ssh::next:https git env')

    expect(run.stdout.trim()).toBe('ssh:https')
  })
})

/** An ls-remote over ssh whose core.sshCommand leaves a marker, so the marker shows the transport ran. */
function sshProbe(
  fx: Fixture,
  prefix: string,
  configs: string,
  subcommand = 'ls-remote',
): { command: string; marker: string } {
  const marker = path.join(fx.work, '..', 'ssh-ran')
  const command = `${prefix} env -u GIT_SSH_COMMAND git -c 'core.sshCommand=touch ${marker}; false' ${configs} ${subcommand} ssh://x.invalid/r`
  return { command, marker }
}

/** The same probe as a clone into ../cloned, with `options` after the subcommand, where clone takes its own -c. */
const cloneProbe = (fx: Fixture, prefix: string, configs: string, options: string) => {
  const probe = sshProbe(fx, prefix, configs, `clone -q ${options}`)
  return { ...probe, command: `${probe.command} ../cloned` }
}

// CC-1336: git honours GIT_ALLOW_PROTOCOL over protocol.*.allow, so the pin must not widen a caller's config.
describe("the pin under a caller's protocol config (CC-1336)", () => {
  // Kills: exporting the pin without narrowing it by the caller's protocol.allow.
  it.each([
    ['protocol.allow=never, variable unset', 'env -u GIT_ALLOW_PROTOCOL', '-c protocol.allow=never'],
    ['protocol.allow=never, variable pinned', 'GIT_ALLOW_PROTOCOL=ssh', '-c protocol.allow=never'],
    // Kills: reading only protocol.allow and not protocol.<name>.allow.
    ['protocol.ssh.allow=never', 'env -u GIT_ALLOW_PROTOCOL', '-c protocol.ssh.allow=never'],
    // Kills: letting the general key win over the protocol's own key.
    ['ssh never over allow always', '', '-c protocol.ssh.allow=never -c protocol.allow=always'],
    // Kills: dropping a protocol only on the exact word never, so a value git rejects keeps it.
    ['protocol.allow=NEVER', '', '-c protocol.allow=NEVER'],
    ['protocol.allow=bogus', '', '-c protocol.allow=bogus'],
    // Kills: keeping a user policy, which a child setting GIT_PROTOCOL_FROM_USER=0 inherits as an outright allow.
    ['protocol.allow=user, not from the user', 'GIT_PROTOCOL_FROM_USER=0', '-c protocol.allow=user'],
    ['protocol.allow=user from the user', '', '-c protocol.allow=user'],
    // Kills: reading values split on newlines, so a second line fakes an always.
    [
      'a never value whose next line says always',
      '',
      `-c 'protocol.ssh.allow=never${'\n'}protocol.ssh.allow always'`,
    ],
  ])('keeps ssh denied under %s', (_label, prefix, configs) => {
    const fx = harness.fixture()
    const probe = sshProbe(fx, prefix, configs)

    const run = runScript(fx, probe.command)

    expect(run.stderr).toContain("transport 'ssh' not allowed")
    expect(fs.existsSync(probe.marker)).toBe(false)
  })

  // Kills: the narrowing dropping a protocol the caller left alone or allowed.
  it.each([
    ['no caller config', ''],
    [
      'protocol.allow=never with protocol.ssh.allow=always',
      '-c protocol.allow=never -c protocol.ssh.allow=always',
    ],
    // Kills: matching the policy word case-sensitively, as git does not.
    ['protocol.ssh.allow=Always over never', '-c protocol.allow=never -c protocol.ssh.allow=Always'],
    ['protocol.ext.allow=never', '-c protocol.ext.allow=never'],
  ])('lets ssh run under %s', (_label, configs) => {
    const fx = harness.fixture()
    const probe = sshProbe(fx, 'env -u GIT_ALLOW_PROTOCOL', configs)

    const run = runScript(fx, probe.command)

    expect(run.stderr).not.toContain('not allowed')
    expect(fs.existsSync(probe.marker)).toBe(true)
  })

  it('reads the policy from the repo -C names', () => {
    const fx = harness.fixture()
    git(fx.work, 'config', 'protocol.ssh.allow', 'never')
    const probe = sshProbe(fx, 'cd .. &&', `-C '${fx.work}'`)

    const run = runScript(fx, probe.command)

    expect(run.stderr).toContain("transport 'ssh' not allowed")
    expect(fs.existsSync(probe.marker)).toBe(false)
  })

  // Kills: reading only the options before the subcommand, so clone's own -c never narrows the pin.
  it.each([
    ['clone -c', '', '-c protocol.allow=never'],
    ['clone -c<value>', '', '-cprotocol.ssh.allow=never'],
    ['a short cluster ending in c', '', '-qc protocol.ssh.allow=never'],
    ['clone --config=', '', '--config=protocol.ssh.allow=never'],
    ['an abbreviated --conf', '', '--conf protocol.allow=never'],
    ['clone -c after the URL', '', ''],
  ])('keeps ssh denied for a clone under %s', (label, configs, options) => {
    const fx = harness.fixture()
    const probe = cloneProbe(fx, '', configs, options)
    const command = label.endsWith('URL') ? `${probe.command} -c protocol.allow=never` : probe.command

    const run = runScript(fx, command)

    expect(run.stderr).toContain("transport 'ssh' not allowed")
    expect(fs.existsSync(probe.marker)).toBe(false)
  })

  // Kills: taking a clone's policy from the cwd repo, whose config clone never reads.
  it("keeps ssh denied for a clone whose cwd repo allows ssh that the caller's config denies", () => {
    const fx = harness.fixture()
    git(fx.work, 'config', 'protocol.ssh.allow', 'always')
    fs.writeFileSync(path.join(fx.work, '..', 'home', '.gitconfig'), '[protocol]\n\tallow = never\n')
    const probe = cloneProbe(fx, '', '', '')

    const run = runScript(fx, probe.command)

    expect(run.stderr).toContain("transport 'ssh' not allowed")
    expect(fs.existsSync(probe.marker)).toBe(false)
  })

  // Kills: the clone reads failing closed on ordinary clones.
  it.each([
    ['no clone config', ''],
    ['an unrelated clone -c', '-c core.autocrlf=false'],
    ['clone -c protocol.ssh.allow=always', '-c protocol.ssh.allow=always'],
  ])('lets a clone run ssh under %s', (_label, options) => {
    const fx = harness.fixture()
    const probe = cloneProbe(fx, '', '', options)

    const run = runScript(fx, probe.command)

    expect(run.stderr).not.toContain('not allowed')
    expect(fs.existsSync(probe.marker)).toBe(true)
  })

  it('clones a local repo with a clone -c', () => {
    const fx = harness.fixture()

    const run = runScript(fx, `git clone -q -c core.autocrlf=false '${fx.work}' ../local`)

    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
  })

  // Kills: keeping a user protocol, which submodule clones (GIT_PROTOCOL_FROM_USER=0) take as an outright allow.
  it('keeps an ssh submodule denied under protocol.allow=user', () => {
    const fx = harness.fixture()
    const head = git(fx.work, 'rev-parse', 'HEAD').trim()
    fs.writeFileSync(
      path.join(fx.work, '.gitmodules'),
      '[submodule "sub"]\n\tpath = sub\n\turl = ssh://x.invalid/sub\n',
    )
    git(fx.work, 'add', '.gitmodules')
    git(fx.work, 'update-index', '--add', '--cacheinfo', `160000,${head},sub`)
    git(fx.work, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'sub')
    const marker = path.join(fx.work, '..', 'ssh-ran')

    runScript(
      fx,
      `env -u GIT_SSH_COMMAND git -c 'core.sshCommand=touch ${marker}; false' -c protocol.allow=user -c protocol.file.allow=always clone -q --recurse-submodules '${fx.work}' ../super`,
    )

    expect(fs.existsSync(path.join(fx.work, '..', 'super', '.gitmodules'))).toBe(true)
    expect(fs.existsSync(marker)).toBe(false)
  })

  // Kills: a caller's protocol.ext.allow=always lifting the pin's ext ban.
  it('keeps ext denied when the caller sets protocol.ext.allow=never or always', () => {
    const { fx, marker } = extFixture()

    const never = runScript(fx, 'GIT_ALLOW_PROTOCOL=ext git -c protocol.ext.allow=never fetch x')
    const always = runScript(fx, 'env -u GIT_ALLOW_PROTOCOL git -c protocol.ext.allow=always fetch x')

    expect(never.stderr).toContain("transport 'ext' not allowed")
    expect(always.stderr).toContain("transport 'ext' not allowed")
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('hands git the narrowed list', () => {
    const { fx } = extFixture(['env'])
    git(fx.work, 'config', 'alias.env', '!printenv GIT_ALLOW_PROTOCOL')

    const run = runScript(fx, 'git -c protocol.file.allow=never -c protocol.git.allow=Never env')

    expect(run.stdout.trim()).toBe('http:https:ssh')
  })
})

/** A template dir beside the fixture's work tree, with `config` holding `body` when one is given. */
function templateDir(fx: Fixture, body?: string): string {
  const dir = path.join(fx.work, '..', 'tpl')
  fs.mkdirSync(dir, { recursive: true })
  if (body !== undefined) fs.writeFileSync(path.join(dir, 'config'), body)
  return dir
}

const DENY_ALL = '[protocol]\n\tallow = never\n'
const DENY_SSH = '[protocol "ssh"]\n\tallow = never\n'
const homeConfig = (fx: Fixture): string => path.join(fx.work, '..', 'home', '.gitconfig')

// CC-1336 review: clone copies its template's config into the new repo and honours it before it fetches.
describe('the pin under a clone template config (CC-1336)', () => {
  // Kills: never reading --template, so its protocol.allow is widened.
  it.each([
    ['--template=<dir> denying all', DENY_ALL, (dir: string) => `--template='${dir}'`],
    ['--template <dir> denying ssh', DENY_SSH, (dir: string) => `--template '${dir}'`],
    ['an abbreviated --templ', DENY_SSH, (dir: string) => `--templ '${dir}'`],
    ['a relative --template under -C', DENY_SSH, () => '--template=tpl'],
  ])('keeps ssh denied for a clone under %s', (label, body, option) => {
    const fx = harness.fixture()
    const dir = templateDir(fx, body)
    const configs = label.includes('-C') ? `-C '${path.dirname(dir)}'` : ''
    const probe = cloneProbe(fx, '', configs, option(dir))

    const run = runScript(fx, probe.command)

    expect(run.stderr).toContain("transport 'ssh' not allowed")
    expect(fs.existsSync(probe.marker)).toBe(false)
  })

  // Kills: reading only --template, not the env var or init.templateDir git falls back to.
  it.each([
    ['GIT_TEMPLATE_DIR', (dir: string) => `GIT_TEMPLATE_DIR='${dir}'`, () => undefined],
    ['a global init.templateDir', () => '', (dir: string) => `[init]\n\ttemplateDir = ${dir}\n`],
    ['an init.templateDir under ~/', () => '', () => '[init]\n\ttemplateDir = ~/../tpl\n'],
  ])('keeps ssh denied for a clone under %s', (_label, prefix, global) => {
    const fx = harness.fixture()
    const dir = templateDir(fx, DENY_ALL)
    const globalBody = global(dir)
    if (globalBody !== undefined) fs.writeFileSync(homeConfig(fx), globalBody)
    const probe = cloneProbe(fx, prefix(dir), '', '')

    const run = runScript(fx, probe.command)

    expect(run.stderr).toContain("transport 'ssh' not allowed")
    expect(fs.existsSync(probe.marker)).toBe(false)
  })

  // Kills: a template read failing closed when the template leaves protocols alone.
  it.each([
    ['a template with no config', undefined],
    ['a template config that allows ssh', '[protocol "ssh"]\n\tallow = always\n'],
  ])('lets a clone run ssh under %s', (_label, body) => {
    const fx = harness.fixture()
    const dir = templateDir(fx, body)
    const probe = cloneProbe(fx, '', '', `--template='${dir}'`)

    const run = runScript(fx, probe.command)

    expect(run.stderr).not.toContain('not allowed')
    expect(fs.existsSync(probe.marker)).toBe(true)
  })
})

/** Adds the fixture's own repo as submodule `sub`, whose origin is an ssh URL; returns the submodule's work tree. */
function withSubmodule(fx: Fixture): string {
  const source = path.join(fx.work, '..', 'sub-source')
  git(path.dirname(source), 'clone', '-q', fx.work, source)
  git(fx.work, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'sub')
  const sub = path.join(fx.work, 'sub')
  git(sub, 'config', 'remote.origin.url', 'ssh://x.invalid/sub')
  return sub
}

const recursingFetch = (marker: string): string =>
  `env -u GIT_SSH_COMMAND -u GIT_ALLOW_PROTOCOL git -c 'core.sshCommand=touch ${marker}; false' fetch -q --recurse-submodules=yes origin`

// CC-1336 review: a recursing fetch's children run real git in each submodule with the exported list.
describe("the pin under a submodule's own protocol config (CC-1336)", () => {
  // Kills: narrowing by the superproject's config alone, so the submodule's never is widened.
  it.each([
    ['protocol.ssh.allow=never', ['protocol.ssh.allow', 'never']],
    ['protocol.allow=never', ['protocol.allow', 'never']],
  ])('keeps ssh denied in a submodule setting %s', (_label, setting) => {
    const fx = harness.fixture()
    const sub = withSubmodule(fx)
    git(sub, 'config', ...setting)
    const marker = path.join(fx.work, '..', 'ssh-ran')

    runScript(fx, recursingFetch(marker))

    expect(fs.existsSync(marker)).toBe(false)
  })

  // Kills: the submodule read failing closed when the submodule leaves protocols alone.
  it('lets the submodule fetch run ssh when its config is silent', () => {
    const fx = harness.fixture()
    withSubmodule(fx)
    const marker = path.join(fx.work, '..', 'ssh-ran')

    runScript(fx, recursingFetch(marker))

    expect(fs.existsSync(marker)).toBe(true)
  })
})

const hasMake = spawnSync('make', ['--version']).status === 0

/** Writes a script that fetches the ext remote, and a one-rule Makefile that runs it. */
function nestedFetch(fx: Fixture): void {
  const dir = path.join(fx.work, '..')
  fs.writeFileSync(path.join(dir, 'inner.sh'), 'git fetch x\n')
  fs.writeFileSync(path.join(dir, 'fetch.mk'), 'all:\n\tsh ../inner.sh\n')
}

const LIFTED_LISTS = [
  ['GIT_ALLOW_PROTOCOL=ext', 'GIT_ALLOW_PROTOCOL=ext'],
  ['unset GIT_ALLOW_PROTOCOL', 'unset GIT_ALLOW_PROTOCOL;'],
  ['an unread value', 'P=ext; GIT_ALLOW_PROTOCOL="$P"'],
] as const

// CC-1137 d: off a git line the guard leaves an unset or unread list to this pin, so a script's git must still refuse.
describe("the pin under a script's own git (CC-1137 d)", () => {
  it.each(LIFTED_LISTS)('refuses a nested script fetching ext:: under %s', (_label, prefix) => {
    const { fx, marker } = extFixture()
    nestedFetch(fx)

    const run = runScript(fx, `${prefix} sh ../inner.sh`)

    expect(run.stderr).toContain("transport 'ext' not allowed")
    expect(run.status).not.toBe(0)
    expect(fs.existsSync(marker)).toBe(false)
  })

  it.skipIf(!hasMake).each(LIFTED_LISTS)('refuses make running that fetch under %s', (_label, prefix) => {
    const { fx, marker } = extFixture()
    nestedFetch(fx)

    const run = runScript(fx, `${prefix} make -s -f ../fetch.mk`)

    expect(run.stderr).toContain("transport 'ext' not allowed")
    expect(run.status).not.toBe(0)
    expect(fs.existsSync(marker)).toBe(false)
  })
})
