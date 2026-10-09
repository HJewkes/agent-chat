import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { gitShimScript } from '../leak-guard/git-shim.js'
import { posixShell } from '../leak-guard/posix-shell.js'
import { type GitShimFixture, gitShimHarness, HOST_PATH, NO_VERIFY } from './helpers/git-shim-fixture.js'

/**
 * CC-612 and the ac#357 follow-ups (CC-613 slice c), against real git, temp repos and a local bare
 * remote. Fake tr and sed refuse to run unless LC_ALL=C, so each LC_ALL=C site in the shim is
 * caught on GNU and BSD tools alike, not only where BSD tr fails on a byte that is not UTF-8.
 */

const { realGit, git, fixture: baseFixture, runScript, remoteHasMain } = gitShimHarness()

const fixture = (): GitShimFixture => baseFixture(['ev', 'ci'])

const commandPath = (name: string): string =>
  execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8', env: { PATH: HOST_PATH } }).trim()

const REAL_FILTERS = { tr: commandPath('tr'), sed: commandPath('sed') }

const LOCALE_CHECK = '[ "$LC_ALL" = C ] || exit 1'

type Filter = keyof typeof REAL_FILTERS

/** Puts a fake tr and sed first on PATH; each runs its check, then execs the real tool. */
function withFakeFilters(fx: GitShimFixture, checks: Partial<Record<Filter, string>> = {}): GitShimFixture {
  const dir = path.join(fx.work, '..', 'fake-bin')
  fs.mkdirSync(dir, { recursive: true })
  for (const name of Object.keys(REAL_FILTERS) as Filter[]) {
    const check = checks[name] ?? LOCALE_CHECK
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${check}\nexec '${REAL_FILTERS[name]}' "$@"\n`, {
      mode: 0o755,
    })
  }
  return { ...fx, env: { ...fx.env, LANG: 'en_US.UTF-8', PATH: `${dir}:${fx.env.PATH}` } }
}

const evAlias = (fx: GitShimFixture): void => {
  git(fx.work, 'config', 'alias.ev', '!f() { eval "git $*"; }; f')
}

const LOCAL_PUSH_SKIPPING_HOOKS = 'git -c core.hooksPath=/dev/null push origin main'

describe('the agent git shim running every text filter under LC_ALL=C (CC-613 slice c)', () => {
  // Kills: LC_ALL=C removed from the tr in mentions_push, or from either tr in args_push.
  it('runs a listed shell alias through the alias checks', () => {
    const fx = withFakeFilters(fixture())
    evAlias(fx)

    const run = runScript(fx, 'git ev log -1 --format=%s')

    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(run.stdout.trim()).toBe('one')
  })

  // Kills: LC_ALL=C removed from the tr or the sed in values().
  it('lets a push to a local bare remote skip the hooks-path rule', () => {
    const fx = withFakeFilters(fixture())

    const run = runScript(fx, LOCAL_PUSH_SKIPPING_HOOKS)

    expect(run.stderr).not.toContain('git-shim:')
    expect(run.status).toBe(0)
    expect(remoteHasMain(fx)).toBe(true)
  })

  // What the mutated run above would show: a failed filter in values() keeps the hooks-path rule.
  it.each(['tr', 'sed'] as Filter[])('refuses as hooks-path when %s fails in the destination check', filter => {
    const fx = withFakeFilters(fixture(), { [filter]: 'exit 1' })

    const run = runScript(fx, LOCAL_PUSH_SKIPPING_HOOKS)

    expect(run.status).toBe(2)
    expect(run.stderr).toContain('git-shim: push refused (hooks-path)')
    expect(remoteHasMain(fx)).toBe(false)
  })

  // Kills: LC_ALL=C removed from the tr that reads the builtin list when none was baked in.
  it('reads the builtin list itself, so a shell alias named like a builtin never runs', () => {
    const fx = withFakeFilters(fixture())
    fs.writeFileSync(
      path.join(fx.shimDir, 'git'),
      gitShimScript(realGit, fx.guard, [], '', posixShell(), ['ev']),
      { mode: 0o755 },
    )
    git(fx.work, 'config', 'alias.log', '!echo hijack')

    const run = runScript(fx, 'git log -1 --format=%s')

    expect(run.status).toBe(0)
    expect(run.stdout).not.toContain('hijack')
    expect(run.stdout.trim()).toBe('one')
  })
})

describe('the agent git shim when a text filter fails (CC-613 slice c)', () => {
  // Each case fails one tr call by its arguments. Kills: `|| refuse unresolved` dropped at that call.
  it.each([
    ['every tr call', 'exit 1'],
    ['the tr in mentions_push', 'case "$1$2" in -d\\"*) exit 1 ;; esac'],
    ['the quote-stripping tr in args_push', 'case "$1$2" in "-d "*) exit 1 ;; esac'],
    ['the lowercasing tr in args_push', 'case "$1" in A-Z) exit 1 ;; esac'],
  ])('refuses a listed shell alias as unresolved when %s fails', (_call, check) => {
    const fx = withFakeFilters(fixture(), { tr: `${LOCALE_CHECK}\n${check}` })
    evAlias(fx)

    const run = runScript(fx, 'git ev log -1 --format=%s')

    expect(run.status).toBe(2)
    expect(run.stderr).toContain('git-shim: push refused (unresolved)')
    expect(run.stdout).toBe('')
  })
})

describe('the agent git shim under a UTF-8 locale (CC-612)', () => {
  const utf8 = (fx: GitShimFixture): GitShimFixture => ({ ...fx, env: { ...fx.env, LANG: 'en_US.UTF-8' } })

  // ev is listed, so the refusal must come from the push checks, not the allowlist gate or a failed filter.
  it('refuses an alias call whose -c value holds byte 0xff before push --no-verify', () => {
    const fx = utf8(fixture())
    evAlias(fx)

    const run = runScript(fx, `git ev -c "x.y=$(printf '\\377')" push ${NO_VERIFY} origin main`)

    expect(run.status).toBe(2)
    expect(run.stderr).toContain('git-shim: push refused (shell-alias)')
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
