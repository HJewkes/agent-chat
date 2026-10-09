import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeLaunchFiles } from '../agents/launch-files.js'
import { buildLaunchPlan } from '../agents/launch-plan.js'
import type { AgentProfile, LaunchPlan, LaunchPlanInput } from '../agents/types.js'
import { findRealGit, GIT_SHIM_DIR_ENV, gitShimScript, writeGitShim } from '../leak-guard/git-shim.js'
import {
  type GitShimFixture as Fixture,
  gitShimHarness,
  HOST_PATH,
  NO_VERIFY,
} from './helpers/git-shim-fixture.js'
import { expectSpawned } from './helpers/spawn-result.js'

/**
 * TP-596, against real git, temp repos and a local bare remote. Each push test names the
 * mutation of the shim it kills; the negative controls are in the PR description.
 */

const harness = gitShimHarness()
const { scratch: SCRATCH, realGit: REAL_GIT, git, runScript, remoteHasMain } = harness

// Every shell alias these tests define is listed, so they exercise args_push and mentions_push, not the CC-613 allowlist gate.
const LISTED_SHELL_ALIASES = ['g', 'p', 'ev', 'hi', 'ci', 'sp', 'ship']

const fixture = (): Fixture => harness.fixture(LISTED_SHELL_ALIASES)

describe('the agent git shim refusing pushes that skip the leak scan', () => {
  // Kills: the argv check removed.
  it('refuses push --no-verify run from a script file', () => {
    const fx = fixture()

    const run = runScript(fx, `git push -q ${NO_VERIFY} origin main`)

    expect(run.stderr).toContain('git-shim: push refused (no-verify)')
    expect(run.status).not.toBe(0)
    expect(remoteHasMain(fx)).toBe(false)
  })

  // Kills: the hooks-path comparison removed.
  it('refuses a push from a script that sets GIT_CONFIG_COUNT=0', () => {
    const fx = fixture()

    const run = runScript(fx, 'GIT_CONFIG_COUNT=0 git push -q net main')

    expect(run.stderr).toContain('git-shim: push refused (hooks-path)')
    expect(run.status).not.toBe(0)
    expect(remoteHasMain(fx)).toBe(false)
  })

  it('refuses a push whose -c option points core.hooksPath elsewhere', () => {
    const fx = fixture()

    const run = runScript(fx, 'git -c core.hooksPath=/dev/null push -q net main')

    expect(run.stderr).toContain('git-shim: push refused (hooks-path)')
    expect(remoteHasMain(fx)).toBe(false)
  })

  // Kills: alias resolution removed.
  it('refuses git p when a repo alias expands to push --no-verify', () => {
    const fx = fixture()
    git(fx.work, 'config', 'alias.p', `push ${NO_VERIFY}`)

    const run = runScript(fx, 'git p -q origin main')

    expect(run.stderr).toContain('git-shim: push refused (no-verify)')
    expect(run.status).not.toBe(0)
    expect(remoteHasMain(fx)).toBe(false)
  })

  it('refuses an alias chain that reaches push --no-verify through a second alias', () => {
    const fx = fixture()
    git(fx.work, 'config', 'alias.p', 'q -q')
    git(fx.work, 'config', 'alias.q', `push ${NO_VERIFY}`)

    const run = runScript(fx, 'git --no-pager p origin main')

    expect(run.stderr).toContain('git-shim: push refused (no-verify)')
    expect(remoteHasMain(fx)).toBe(false)
  })

  it('refuses a shell alias that pushes', () => {
    const fx = fixture()
    git(fx.work, 'config', 'alias.ship', `!git push ${NO_VERIFY} origin main`)

    const run = runScript(fx, 'git ship')

    expect(run.stderr).toContain('git-shim: push refused (shell-alias)')
    expect(remoteHasMain(fx)).toBe(false)
  })
})

describe('the agent git shim failing closed when it cannot resolve a push (fix round 1)', () => {
  // Each case pushed without the hook at 789da5ba: sh word splitting kept the quotes, so the lookup missed.
  it.each([
    ['"push"', `git p ${NO_VERIFY} origin main`, 'no-verify'],
    ["'push'", 'git -c core.hooksPath=/dev/null p net main', 'hooks-path'],
    ['pu\\sh', `git p ${NO_VERIFY} origin main`, 'no-verify'],
    ['"push" "--no-verify"', 'git p origin main', 'no-verify'],
  ])('refuses alias.p=%s split the way git splits it', (alias, command, rule) => {
    const fx = fixture()
    git(fx.work, 'config', 'alias.p', alias)

    const run = runScript(fx, command)

    expect(run.stderr).toContain(`git-shim: push refused (${rule})`)
    expect(run.status).toBe(2)
    expect(remoteHasMain(fx)).toBe(false)
  })

  it('refuses an alias with an open quote rather than passing it to git', () => {
    const fx = fixture()
    git(fx.work, 'config', 'alias.p', '"push')

    const run = runScript(fx, 'git p origin main')

    expect(run.stderr).toContain('git-shim: push refused (unresolved)')
    expect(run.status).toBe(2)
  })

  it('refuses an alias chain deeper than 10 that ends in push --no-verify', () => {
    const fx = fixture()
    for (let level = 0; level < 12; level++) git(fx.work, 'config', `alias.a${level}`, `a${level + 1}`)
    git(fx.work, 'config', 'alias.a12', `push ${NO_VERIFY}`)

    const run = runScript(fx, 'git a0 origin main')

    expect(run.stderr).toContain('git-shim: push refused (alias-depth)')
    expect(run.status).toBe(2)
    expect(remoteHasMain(fx)).toBe(false)
  })

  it.each([
    [`git push ${NO_VERIFY} origin main`, 'no-verify'],
    ['git -c core.hooksPath=/dev/null push net main', 'hooks-path'],
  ])('refuses %s when the builtin list could not be read', (command, rule) => {
    const fx = fixture()
    const real = findRealGit(HOST_PATH, fx.shimDir) as string
    fs.writeFileSync(path.join(fx.shimDir, 'git'), gitShimScript(real, fx.guard, []), { mode: 0o755 })

    const run = runScript(fx, command)
    const status = runScript(fx, 'git rev-parse --verify -q refs/heads/absent; echo "status=$?"')

    expect(run.stderr).toContain(`git-shim: push refused (${rule})`)
    expect(remoteHasMain(fx)).toBe(false)
    expect(status.stdout.trim()).toBe('status=1')
  })

  // At 789da5ba the inner git refused as no-verify; the outer shim now names the shell alias itself.
  it.each([
    ['!git', `git g push ${NO_VERIFY} origin main`],
    ["!git pu''sh origin main", 'git g'],
  ])('refuses the shell alias %s when it or its arguments mention push', (alias, command) => {
    const fx = fixture()
    git(fx.work, 'config', 'alias.g', alias)

    const run = runScript(fx, command)

    expect(run.stderr).toContain('git-shim: push refused (shell-alias)')
    expect(remoteHasMain(fx)).toBe(false)
  })

  // At 446bc7a4 these arguments passed the shim and the alias body's eval assembled push.
  it.each([
    ['command substitution', '$(echo pu)sh'],
    ['variable expansion', '${P:-pu}sh'],
    ['bare variable', '$P'],
    ['backtick substitution', '`echo pu`sh'],
    ['brace expansion', '{pu,}sh'],
  ])('refuses a shell alias whose eval could build push from %s', (_form, arg) => {
    const fx = fixture()
    git(fx.work, 'config', 'alias.ev', '!f() { eval "git $*"; }; f')

    const run = runScript(fx, `git ev '${arg}' origin main`)

    expect(run.status).toBe(2)
    expect(run.stderr).toContain('git-shim: push refused (shell-alias)')
    expect(remoteHasMain(fx)).toBe(false)
  })

  it('still runs a shell alias that does not mention push', () => {
    const fx = fixture()
    git(fx.work, 'config', 'alias.hi', '!echo hello')

    const run = runScript(fx, 'git hi')

    expect(run.stdout.trim()).toBe('hello')
    expect(run.status).toBe(0)
  })
})

describe('the agent git shim and help.autocorrect (fix round 2)', () => {
  // At c679bb28 the alias miss exec'd the real git, which corrected pusj to push and skipped the hook.
  it.each([
    ['-c help.autocorrect=immediate', NO_VERIFY],
    ['-c help.autocorrect=1', NO_VERIFY],
    ['-c help.autocorrect=true', NO_VERIFY],
    ['-c help.autocorrect=5', NO_VERIFY],
    ['-c help.autocorrect=prompt', NO_VERIFY],
    ['-c help.autocorrect', NO_VERIFY],
    ['-c help.autocorrect=immediate -c core.hooksPath=/dev/null', ''],
  ])('refuses a mistyped push under git %s', (options, flag) => {
    const fx = fixture()

    const run = runScript(fx, `git ${options} pusj origin main ${flag}`)

    expect(run.stderr).toContain('git-shim: push refused (autocorrect)')
    expect(run.status).toBe(2)
    expect(remoteHasMain(fx)).toBe(false)
  })

  it.each(['', '-c help.autocorrect=never', '-c help.autocorrect=0', '-c help.autocorrect=show'])(
    'leaves an unknown word to git when autocorrect cannot run it (%s)',
    options => {
      const fx = fixture()

      const run = runScript(fx, `git ${options} pusj origin main`)

      expect(run.stderr).not.toContain('git-shim')
      expect(run.stderr).toContain('is not a git command')
      expect(remoteHasMain(fx)).toBe(false)
    },
  )

  it('runs an external git-<word> command under autocorrect', () => {
    const fx = fixture()
    const bin = path.join(fx.work, '..', 'ext-bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'git-hello'), '#!/bin/sh\necho hello\n', { mode: 0o755 })

    const run = runScript(fx, `PATH='${bin}':$PATH git -c help.autocorrect=immediate hello`)

    expect(run.stdout.trim()).toBe('hello')
    expect(run.status).toBe(0)
  })

  it('runs builtins under autocorrect when the baked builtin list is empty', () => {
    const fx = fixture()
    const real = findRealGit(HOST_PATH, fx.shimDir) as string
    fs.writeFileSync(path.join(fx.shimDir, 'git'), gitShimScript(real, fx.guard, []), { mode: 0o755 })

    const run = runScript(fx, 'git -c help.autocorrect=1 rev-parse --abbrev-ref HEAD')

    expect(run.stdout.trim()).toBe('main')
    expect(run.status).toBe(0)
  })

  it('runs a shell alias whose only push is git stash push', () => {
    const fx = fixture()
    git(fx.work, 'config', 'alias.sp', '!git stash push -q')

    const run = runScript(fx, 'git sp')

    expect(run.stderr).not.toContain('git-shim')
    expect(run.status).toBe(0)
  })
})

describe('the agent git shim letting a push to a local repository skip the hooks-path check (CC-442)', () => {
  const FOREIGN = 'git -c core.hooksPath=/dev/null push -q'

  /** A fixture push with a hooks path that is not the guard's, as a test harness that strips it makes. */
  const foreignPush = (fx: Fixture, args: string) => runScript(fx, `${FOREIGN} ${args}`)

  // Kills: local_only always false.
  it.each([
    ['an absolute path', (fx: Fixture) => `'${fx.remote}' main`],
    ['a relative path', () => '../remote.git main'],
    ['a file:// URL', (fx: Fixture) => `'file://${fx.remote}' main`],
    ['a remote named origin whose url is a path', () => '-u origin main'],
    ['the default remote, origin', () => '--all'],
  ])('lets a push to %s through with a foreign hooks path', (_label, args) => {
    const fx = fixture()

    const run = foreignPush(fx, args(fx))

    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(remoteHasMain(fx)).toBe(true)
  })

  it('lets a remote with two pushurls through when both are paths', () => {
    const fx = fixture()
    const second = path.join(fx.work, '..', 'second.git')
    git(fx.work, 'init', '-q', '--bare', second)
    git(fx.work, 'config', '--add', 'remote.origin.pushurl', fx.remote)
    git(fx.work, 'config', '--add', 'remote.origin.pushurl', second)

    const run = foreignPush(fx, 'origin main')

    expect(run.status).toBe(0)
    expect(remoteHasMain(fx)).toBe(true)
  })

  // Kills: the insteadOf rewrite left out of the destinations.
  it.each([
    ['insteadOf', 'url.https://github.com/acme/.insteadOf'],
    ['pushInsteadOf', 'url.https://github.com/acme/.pushInsteadOf'],
  ])('refuses a path remote that %s rewrites to github.com', (_label, key) => {
    const fx = fixture()
    git(fx.work, 'config', key, path.dirname(fx.remote))

    const run = foreignPush(fx, 'origin main')

    expect(run.stderr).toContain('git-shim: push refused (hooks-path)')
    expect(run.status).toBe(2)
  })

  it.each([
    ['ext::', "'ext::sh -c true' main"],
    ['fd::', 'fd::3 main'],
    ['an ssh URL', 'ssh://git.invalid/r.git main'],
    ['an https URL', 'https://git.invalid/r.git main'],
    ['an scp-like host:path', 'git.invalid:r.git main'],
    ['a remote whose url is ssh', 'net main'],
    ['a local path with --receive-pack', "--receive-pack='git receive-pack' ../remote.git main"],
    ['a local path with an unknown option', '--unknown-option ../remote.git main'],
    ['a local path with submodule pushes on', '--recurse-submodules=on-demand ../remote.git main'],
  ])('refuses a push to %s with a foreign hooks path', (_label, args) => {
    const fx = fixture()

    const run = foreignPush(fx, args)

    expect(run.stderr).toContain('git-shim: push refused (hooks-path)')
    expect(run.status).toBe(2)
    expect(remoteHasMain(fx)).toBe(false)
  })

  // Kills: requiring only one local destination instead of all.
  it('refuses a remote with a path pushurl and an ssh pushurl', () => {
    const fx = fixture()
    git(fx.work, 'config', '--add', 'remote.origin.pushurl', fx.remote)
    git(fx.work, 'config', '--add', 'remote.origin.pushurl', 'ssh://git.invalid/r.git')

    const run = foreignPush(fx, 'origin main')

    expect(run.stderr).toContain('git-shim: push refused (hooks-path)')
    expect(remoteHasMain(fx)).toBe(false)
  })

  it.each([
    ['its url holds a newline', (fx: Fixture) => git(fx.work, 'config', 'remote.odd.url', `${fx.remote}\nx`)],
    ['it names a remote helper', (fx: Fixture) => git(fx.work, 'config', 'remote.odd.vcs', 'x')],
    [
      'it is a legacy remotes file',
      (fx: Fixture) => {
        fs.mkdirSync(path.join(fx.work, '.git', 'remotes'))
        fs.writeFileSync(path.join(fx.work, '.git', 'remotes', 'odd'), 'URL: ssh://git.invalid/r.git\n')
      },
    ],
  ])('refuses a remote the shim cannot resolve: %s', (_label, setup) => {
    const fx = fixture()
    setup(fx)

    const run = foreignPush(fx, 'odd main')

    expect(run.stderr).toContain('git-shim: push refused (hooks-path)')
    expect(remoteHasMain(fx)).toBe(false)
  })

  // At 49e14d0c symbolic-ref --short gave heads/main when a tag main existed, so the push fell through to origin.
  it.each([
    ['a tag main', 'branch.main.pushRemote', ['tag', 'main']],
    ['a tag main', 'branch.main.remote', ['tag', 'main']],
    ['a ref refs/main', 'branch.main.pushRemote', ['update-ref', 'refs/main', 'HEAD']],
    ['a ref refs/main', 'branch.main.remote', ['update-ref', 'refs/main', 'HEAD']],
  ])('refuses a bare push beside %s when %s names an ssh remote', (_label, key, ambiguity) => {
    const fx = fixture()
    git(fx.work, ...ambiguity)
    git(fx.work, 'config', key, 'evil')
    git(fx.work, 'config', 'remote.evil.url', 'git.invalid:r.git')

    const run = foreignPush(fx, '')

    expect(run.stderr).toContain('git-shim: push refused (hooks-path)')
    expect(run.status).toBe(2)
  })

  it('refuses a bare push from a detached HEAD', () => {
    const fx = fixture()
    git(fx.work, 'checkout', '-q', '--detach')

    const run = foreignPush(fx, '--all')

    expect(run.stderr).toContain('git-shim: push refused (hooks-path)')
    expect(remoteHasMain(fx)).toBe(false)
  })

  it.each([
    ['push.recurseSubmodules', 'on-demand'],
    ['push.recurseSubmodules', 'only'],
    ['submodule.recurse', 'true'],
  ])('refuses a push to a local path when %s is %s', (key, value) => {
    const fx = fixture()
    git(fx.work, 'config', key, value)

    const run = foreignPush(fx, 'origin main')

    expect(run.stderr).toContain('git-shim: push refused (hooks-path)')
    expect(remoteHasMain(fx)).toBe(false)
  })

  // Kills: a config read error in values() taken as an unset key.
  it.each([
    ['remote.origin.vcs'],
    ['remote.origin.pushurl'],
    ['remote.origin.url'],
    ['-z url.https://github.com/acme/.insteadof'],
  ])('refuses a push to a local remote when git fails to read %s', words => {
    const fx = fixture()
    git(fx.work, 'config', 'url.https://github.com/acme/.insteadOf', '/no-such-prefix/')
    const failing = path.join(fx.work, '..', 'failing-git')
    const match = words
      .split(' ')
      .map(word => `case " $* " in *" ${word} "*) ;; *) exec '${REAL_GIT}' "$@" ;; esac`)
      .join('\n')
    fs.writeFileSync(failing, `#!/bin/sh\n${match}\necho 'error: injected' >&2\nexit 3\n`, { mode: 0o755 })
    fs.writeFileSync(path.join(fx.shimDir, 'git'), gitShimScript(failing, fx.guard, []), { mode: 0o755 })

    const run = foreignPush(fx, 'origin main')

    expect(run.stderr).toContain('git-shim: push refused (hooks-path)')
    expect(remoteHasMain(fx)).toBe(false)
  })

  it('still refuses --no-verify to a local path', () => {
    const fx = fixture()

    const run = runScript(fx, `git push -q ${NO_VERIFY} '${fx.remote}' main`)

    expect(run.stderr).toContain('git-shim: push refused (no-verify)')
    expect(remoteHasMain(fx)).toBe(false)
  })
})

describe('the agent git shim passing everything else to the real git', () => {
  // Kills: the shim not exec-ing the real git.
  it('lets a plain push through and the pre-push hook still runs', () => {
    const fx = fixture()

    const run = runScript(fx, 'git -C . push -q origin main')

    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(remoteHasMain(fx)).toBe(true)
    expect(fs.existsSync(fx.marker)).toBe(true)
  })

  // Kills: the exit status or stdout swallowed.
  it('passes other subcommands through with their exit code and stdout', () => {
    const fx = fixture()

    const head = runScript(fx, 'git rev-parse HEAD')
    const missing = runScript(fx, 'git cat-file -e 0000000000000000000000000000000000000001')
    const failed = runScript(fx, 'git rev-parse --verify -q refs/heads/absent; echo "status=$?"')

    expect(head.stdout.trim()).toBe(git(fx.work, 'rev-parse', 'HEAD').trim())
    expect(head.status).toBe(0)
    expect(missing.status).toBe(
      spawnSync(REAL_GIT, ['cat-file', '-e', '0000000000000000000000000000000000000001'], { cwd: fx.work })
        .status,
    )
    expect(failed.stdout.trim()).toBe('status=1')
  })

  // Kills: the shim calling git by name, which finds itself first on PATH (timeout).
  it('does not recurse into itself', () => {
    const fx = fixture()
    writeGitShim(fx.shimDir, fx.guard, `${fx.env.PATH}:${HOST_PATH}`)

    const run = runScript(fx, 'git --version && git status --short && git push -q origin main')

    expect(run.error).toBeUndefined()
    expect(run.status).toBe(0)
    expect(run.stdout).toMatch(/^git version /)
    expect(remoteHasMain(fx)).toBe(true)
  })
})

describe('where the agent git shim is put on PATH', () => {
  const profile: AgentProfile = {
    name: 'test',
    description: 'a profile',
    model: 'sonnet',
    allowedTools: ['Read'],
    isolation: 'none',
    surface: 'headless',
    promptPrelude: '',
  }
  const input = (over: Partial<LaunchPlanInput> = {}): LaunchPlanInput => ({
    agentId: 'ag000001',
    sessionId: '00000000-0000-4000-8000-000000000001',
    name: 'scout',
    profile,
    brief: 'brief',
    cwd: '/repo',
    cwdHoldsUserSettings: false,
    mcpConfigPath: '/state/agents/ag000001/mcp.json',
    ...over,
  })

  it('names <home>/git-bin in the plan only when the guard hooks are set, and a profile cannot move it', () => {
    const hostile = { ...profile, env: { [GIT_SHIM_DIR_ENV]: '/elsewhere', PATH: '/usr/bin' } }

    const guarded = buildLaunchPlan(input({ profile: hostile, gitHooksDir: '/state/git-hooks' }))

    expect(guarded.env[GIT_SHIM_DIR_ENV]).toBe('/state/git-bin')
    expect(GIT_SHIM_DIR_ENV in buildLaunchPlan(input()).env).toBe(false)
  })

  it('writes <home>/git-bin/git beside the guard hooks at spawn, and nothing without them', () => {
    const home = fs.mkdtempSync(path.join(SCRATCH, 'home-'))
    process.env.AGENT_CHAT_HOME = home
    const hooks = path.join(home, 'git-hooks')
    const shim = path.join(home, 'git-bin', 'git')
    try {
      writeLaunchFiles(buildLaunchPlan(input()), {})
      expect(fs.existsSync(shim)).toBe(false)

      writeLaunchFiles(buildLaunchPlan(input({ gitHooksDir: hooks })), {})
    } finally {
      delete process.env.AGENT_CHAT_HOME
    }

    expect(fs.statSync(shim).mode & 0o777).toBe(0o755)
    expect(fs.readFileSync(shim, 'utf8')).toContain(`guard='${hooks}'`)
  })

  const CLI = path.join(import.meta.dirname, '..', '..', 'dist', 'cli.js')

  /** The PATH the launched process sees, from the built `run-agent`. */
  function launchedPath(planEnv: Record<string, string>): string[] {
    const state = fs.mkdtempSync(path.join(SCRATCH, 'state-'))
    const fake = path.join(state, 'fake-claude.js')
    fs.writeFileSync(fake, 'process.stdout.write(process.env.PATH)\n')
    const plan: LaunchPlan = {
      agentId: 'agt-test',
      bin: 'claude',
      args: [fake],
      cwd: state,
      env: planEnv,
      title: 'agt-test',
      surface: 'headless',
    }
    fs.mkdirSync(path.join(state, 'agents', 'agt-test'), { recursive: true })
    fs.writeFileSync(path.join(state, 'agents', 'agt-test', 'plan.json'), JSON.stringify(plan))
    const run = expectSpawned(
      spawnSync(process.execPath, [CLI, 'run-agent', 'agt-test'], {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', AGENT_CHAT_HOME: state, AGENT_CHAT_CLAUDE: process.execPath },
      }),
      'run-agent agt-test',
    )
    return run.stdout.split(':')
  }

  it('puts the shim dir first on an agent launch PATH, ahead of a PATH the plan sets', () => {
    const entries = launchedPath({ [GIT_SHIM_DIR_ENV]: '/state/git-bin', PATH: '/plan/bin' })

    expect(entries[0]).toBe('/state/git-bin')
    expect(entries).toContain('/plan/bin')
  })

  // Kills: the prepend applied outside the agent launch path.
  it('a human launch env has no shim dir on PATH', () => {
    const before = process.env.PATH
    const entries = launchedPath({})

    expect(entries.some(entry => entry.endsWith('git-bin'))).toBe(false)
    expect(process.env.PATH).toBe(before)
  })
})

describe('the agent git shim under a UTF-8 locale (CC-612)', () => {
  const utf8 = (fx: Fixture): Fixture => ({ ...fx, env: { ...fx.env, LANG: 'en_US.UTF-8' } })
  const evAlias = (fx: Fixture): void => {
    git(fx.work, 'config', 'alias.ev', '!f() { eval "git $*"; }; f')
  }
  it('refuses an alias call whose -c value holds byte 0xff before push --no-verify', () => {
    const fx = utf8(fixture())
    evAlias(fx)
    const run = runScript(fx, `git ev -c "x.y=$(printf '\\377')" push ${NO_VERIFY} origin main`)

    expect(run.status).toBe(2)
    expect(run.stderr).toContain('git-shim: push refused')
    expect(remoteHasMain(fx)).toBe(false)
  })

  it('still runs a plain push and the pre-push hook', () => {
    const fx = utf8(fixture())

    const run = runScript(fx, 'git push -q origin main')

    expect(run.status).toBe(0)
    expect(remoteHasMain(fx)).toBe(true)
    expect(fs.existsSync(fx.marker)).toBe(true)
  })

  it('still runs a commit whose message holds valid non-ASCII UTF-8 through a shell alias', () => {
    const fx = utf8(fixture())
    git(fx.work, 'config', 'alias.ci', '!git commit --allow-empty -q -m')

    const run = runScript(fx, "git -c user.name=t -c user.email=t@example.com ci 'café'")

    expect(run.status).toBe(0)
    expect(git(fx.work, 'log', '-1', '--format=%s').trim()).toBe('café')
  })
})
