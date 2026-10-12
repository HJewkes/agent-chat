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
