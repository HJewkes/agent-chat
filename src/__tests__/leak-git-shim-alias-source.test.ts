import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { type GitShimFixture, gitShimHarness } from './helpers/git-shim-fixture.js'

/**
 * CC-613 slice d, against real git, temp repos and a local bare remote: a listed `!` alias runs
 * only the body in config files. Each shadowing route defines the listed name for one call with a
 * body that builds push at run time and skips the hook; before this fix each one pushed.
 */

const { git, fixture, runScript, remoteHasMain } = gitShimHarness()

const BODY = `BODY='!echo hsup | rev | xargs -I% git -c core.hooksPath=/dev/null % -q origin main'`

const SHADOWS: [string, string][] = [
  ['-c alias.hi', 'git -c "alias.hi=$BODY" hi'],
  ['-c alias.HI', 'git -c "alias.HI=$BODY" hi'],
  ['-c Alias.hi', 'git -c "Alias.hi=$BODY" hi'],
  ['--config-env=alias.hi', 'V=$BODY git --config-env=alias.hi=V hi'],
  ['GIT_CONFIG_PARAMETERS', `GIT_CONFIG_PARAMETERS="'alias.hi'='$BODY'" git hi`],
  ['GIT_CONFIG_COUNT', 'GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_1=alias.hi GIT_CONFIG_VALUE_1="$BODY" git hi'],
  [
    '-c include.path',
    `printf '[alias]\\n\\thi = %s\\n' "$BODY" >../inc; git -c include.path="$PWD/../inc" hi`,
  ],
]

const WRITE_INC = `printf '[alias]\\n\\thi = %s\\n' "$BODY"`

// Routes that pick which config files git reads for one call; the first two outrank a ~/.gitconfig definition.
const FILE_SWAPS: [string, string][] = [
  ['GIT_CONFIG_GLOBAL', `${WRITE_INC} >../inc; GIT_CONFIG_GLOBAL="$PWD/../inc" git hi`],
  ['HOME', `mkdir ../h; ${WRITE_INC} >../h/.gitconfig; HOME="$PWD/../h" git hi`],
  ['XDG_CONFIG_HOME', `mkdir -p ../x/git; ${WRITE_INC} >../x/git/config; XDG_CONFIG_HOME="$PWD/../x" git hi`],
  [
    'GIT_CONFIG_SYSTEM',
    `${WRITE_INC} >../inc; env -u GIT_CONFIG_NOSYSTEM GIT_CONFIG_SYSTEM="$PWD/../inc" git hi`,
  ],
]

const globalConfig = (fx: GitShimFixture, text: string): void => {
  const file = path.join(fx.work, '..', 'home', '.config', 'git', 'config')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

describe('the agent git shim refusing a listed shell alias set outside config files (CC-613 d)', () => {
  // Kills: reading the listed body with the typed -c options or the GIT_CONFIG_* env in force.
  it.each(SHADOWS)('refuses a listed name shadowed by %s', (_route, command) => {
    const fx = fixture(['hi'])

    const run = runScript(fx, `${BODY}\n${command}`)

    expect(remoteHasMain(fx)).toBe(false)
    expect(fs.existsSync(fx.marker)).toBe(false)
    expect(run.stderr).toContain('git-shim: refused (shell-alias)')
    expect(run.status).toBe(2)
  })

  // Kills: a check that only looks for a definition missing from the config files.
  it.each(SHADOWS)('refuses %s over a benign listed alias in the repo config', (_route, command) => {
    const fx = fixture(['hi'])
    git(fx.work, 'config', 'alias.hi', '!echo hello')

    const run = runScript(fx, `${BODY}\n${command}`)

    expect(remoteHasMain(fx)).toBe(false)
    expect(run.stderr).toContain('git-shim: refused (shell-alias)')
    expect(run.status).toBe(2)
    expect(run.stdout).toBe('')
  })

  // Kills: comparing against config files chosen with the call's own HOME, XDG_CONFIG_HOME or GIT_CONFIG_* paths.
  it.each(FILE_SWAPS)('refuses a listed name defined in a file chosen by %s', (_route, command) => {
    const fx = fixture(['hi'])

    const run = runScript(fx, `${BODY}\n${command}`)

    expect(remoteHasMain(fx)).toBe(false)
    expect(fs.existsSync(fx.marker)).toBe(false)
    expect(run.stderr).toContain('git-shim: refused (shell-alias)')
    expect(run.status).toBe(2)
  })

  it.each(FILE_SWAPS.slice(0, 2))(
    'refuses %s over a benign listed alias in the global config',
    (_route, command) => {
      const fx = fixture(['hi'])
      fs.writeFileSync(path.join(fx.work, '..', 'home', '.gitconfig'), '[alias]\n\thi = !echo hello\n')

      const run = runScript(fx, `${BODY}\n${command}`)

      expect(remoteHasMain(fx)).toBe(false)
      expect(run.stderr).toContain('git-shim: refused (shell-alias)')
      expect(run.status).toBe(2)
      expect(run.stdout).toBe('')
    },
  )

  // Kills: a refusal of every listed alias, or of any typed -c.
  it.each([
    ['the repo config', 'git hi'],
    ['the repo config with an unrelated -c', 'git -c user.name=x hi'],
    [
      'the repo config with an unrelated GIT_CONFIG_COUNT key',
      'GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_1=user.name GIT_CONFIG_VALUE_1=x git hi',
    ],
  ])('runs a listed alias defined in %s', (_where, command) => {
    const fx = fixture(['hi'])
    git(fx.work, 'config', 'alias.hi', '!echo hello')

    const run = runScript(fx, command)

    expect(run.stderr).toBe('')
    expect(run.stdout.trim()).toBe('hello')
    expect(run.status).toBe(0)
  })

  it('runs a listed alias defined in the global config', () => {
    const fx = fixture(['hi'])
    fs.writeFileSync(path.join(fx.work, '..', 'home', '.gitconfig'), '[alias]\n\thi = !echo hello\n')

    const run = runScript(fx, 'git hi')

    expect(run.stderr).toBe('')
    expect(run.stdout.trim()).toBe('hello')
    expect(run.status).toBe(0)
  })

  // Kills: dropping the baked HOME, which would hide the XDG config under it.
  it('runs a listed alias defined in the XDG config under HOME', () => {
    const fx = fixture(['hi'])
    globalConfig(fx, '[alias]\n\thi = !echo hello\n')

    const run = runScript(fx, 'git hi')

    expect(run.stderr).toBe('')
    expect(run.stdout.trim()).toBe('hello')
    expect(run.status).toBe(0)
  })

  // -C picks a repo as cd does, so its config counts as a config file; dropping -C would refuse git -C <repo> hi.
  it('runs a listed alias from a repo named with -C', () => {
    const fx = fixture(['hi'])
    git(fx.work, 'config', 'alias.hi', '!echo hello')

    const run = runScript(fx, 'cd .. && git -C work hi')

    expect(run.stderr).toBe('')
    expect(run.stdout.trim()).toBe('hello')
    expect(run.status).toBe(0)
  })
})
