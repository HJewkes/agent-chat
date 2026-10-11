import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { gitShimScript } from '../leak-guard/git-shim.js'
import { posixShell } from '../leak-guard/posix-shell.js'
import { type GitShimFixture, gitShimHarness, NO_VERIFY } from './helpers/git-shim-fixture.js'

/**
 * CC-613, against real git, temp repos and a local bare remote: a shell (!) alias runs only when
 * its name is on the baked allowlist. Each reproduction builds push in a way the push and argument
 * checks cannot see, so only the allowlist gate stops it; the controls list it and watch it push.
 */

const { realGit, git, fixture, runScript, remoteHasMain } = gitShimHarness()

const pushCommand = `git push ${NO_VERIFY} origin main`

// Each pushed with the hook skipped before CC-613 (review d16c219d on ac#350).
const REPRODUCTIONS: [string, string, string][] = [
  ['rev|xargs', `!git version; echo hsup | rev | xargs -I% git % ${NO_VERIFY} origin main`, 'git rv'],
  ['tr', `!echo PUSH | tr A-Z a-z | xargs -I% git % ${NO_VERIFY} origin main`, 'git rv'],
  ['base64|sh', `!echo ${Buffer.from(pushCommand).toString('base64')} | base64 --decode | sh`, 'git rv'],
  ['env', `!git $P ${NO_VERIFY} origin main; true`, 'P=push git rv'],
]

const pushedWithoutHook = (fx: GitShimFixture): boolean => remoteHasMain(fx) && !fs.existsSync(fx.marker)

describe('the agent git shim refusing a shell alias that is not on the allowlist (CC-613)', () => {
  // Kills: the allowlist gate in resolve() removed; the controls below show each one then pushes.
  it.each(REPRODUCTIONS)('refuses the unlisted %s reproduction', (_form, alias, command) => {
    const fx = fixture()
    git(fx.work, 'config', 'alias.rv', alias)

    const run = runScript(fx, command)

    expect(run.status).toBe(2)
    expect(run.stderr).toContain('git-shim: refused (shell-alias)')
    expect(remoteHasMain(fx)).toBe(false)
    expect(fs.existsSync(fx.marker)).toBe(false)
  })

  // Control: proves the reproductions are real bypasses, so the refusals above are not vacuous.
  it.each(REPRODUCTIONS)(
    'lets the listed %s reproduction push with the hook skipped',
    (_form, alias, command) => {
      const fx = fixture(['rv'])
      git(fx.work, 'config', 'alias.rv', alias)

      const run = runScript(fx, command)

      expect(run.stderr).not.toContain('git-shim:')
      expect(pushedWithoutHook(fx)).toBe(true)
    },
  )

  // Kills: a gate that always refuses, or one that reads the wrong variable.
  it('runs a listed shell alias', () => {
    const fx = fixture(['hi'])
    git(fx.work, 'config', 'alias.hi', '!echo hello')

    const run = runScript(fx, 'git hi')

    expect(run.stdout.trim()).toBe('hello')
    expect(run.status).toBe(0)
  })

  // Kills: a gate placed after the alias runs.
  it('refuses an unlisted shell alias before it runs, push or not', () => {
    const fx = fixture()
    git(fx.work, 'config', 'alias.hi', '!echo hello')

    const run = runScript(fx, 'git hi')

    expect(run.status).toBe(2)
    expect(run.stderr).toContain('git-shim: refused (shell-alias)')
    expect(run.stdout).toBe('')
  })

  // Kills: checking the word typed instead of the shell alias a chain reaches.
  it('refuses an unlisted shell alias reached through a listed plain alias', () => {
    const fx = fixture(['x'])
    git(fx.work, 'config', 'alias.x', 'rv')
    git(fx.work, 'config', 'alias.rv', '!echo hello')

    const run = runScript(fx, 'git x')

    expect(run.status).toBe(2)
    expect(run.stderr).toContain('alias.rv')
    expect(run.stdout).toBe('')
  })

  // Kills: a substring or case-folding match. git finds alias.hi for HI; refusing it is a documented false refusal.
  it.each([
    [['hi'], 'git HI'],
    [['hix'], 'git hi'],
    [['xhi'], 'git hi'],
    [['h'], 'git hi'],
  ])('with the allowlist %j refuses %s', (listed, command) => {
    const fx = fixture(listed)
    git(fx.work, 'config', 'alias.hi', '!echo hello')

    const run = runScript(fx, command)

    expect(run.status).toBe(2)
    expect(run.stderr).toContain('git-shim: refused (shell-alias)')
  })
})

describe('baking the shell alias allowlist into the shim (CC-613)', () => {
  // Kills: dropping the alias-name filter, which would let a listed name inject shell into the shim.
  it('keeps only valid alias names, lowercased', () => {
    const script = gitShimScript(realGit, '/guard', [], '', posixShell(), [
      'Ok',
      'a b',
      "x';touch y;'",
      '-n',
      '',
    ])

    expect(script).toContain("shell_aliases='ok'\n")
  })

  it('bakes an empty allowlist by default', () => {
    expect(gitShimScript(realGit, '/guard', [])).toContain("shell_aliases=''\n")
  })
})
