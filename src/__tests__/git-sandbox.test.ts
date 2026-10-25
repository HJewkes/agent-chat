import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { gitOverlayTargets, probeSandbox, sandboxArgv, type SandboxGit } from '../agents/git-sandbox.js'

const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-git-sandbox-')))
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }))

function writeExecutable(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 })
}

/** A fake install: two PATH dirs holding git, a core, and a mirror linking builtins to the shim. */
function fakeInstall(): { git: SandboxGit; pathValue: string; root: string } {
  const root = fs.mkdtempSync(path.join(SCRATCH, 'install-'))
  const at = (...parts: string[]): string => path.join(root, ...parts)
  const core = at('git-core')
  const shim = at('shim', 'git')
  const realCopy = at('git-real', 'k', 'git')
  for (const file of [at('usr-bin', 'git'), at('local-bin', 'git'), shim, realCopy]) writeExecutable(file)
  for (const name of ['git', 'git-push', 'git-send-pack', 'git-remote-https'])
    writeExecutable(path.join(core, name))
  const mirror = at('shim', 'core')
  fs.mkdirSync(mirror)
  for (const name of ['git', 'git-push', 'git-send-pack', 'git-stash'])
    fs.symlinkSync(shim, path.join(mirror, name))
  fs.symlinkSync(path.join(core, 'git-remote-https'), path.join(mirror, 'git-remote-https'))
  const pathValue = [
    path.dirname(realCopy),
    at('usr-bin'),
    at('local-bin'),
    at('no-such-dir'),
    'relative',
  ].join(':')
  return { git: { shim, mirror, core, realCopy }, pathValue, root }
}

describe('gitOverlayTargets (CC-1645 S2)', () => {
  it('lists every git on PATH and each core builtin the mirror links to the shim', () => {
    const { git, pathValue, root } = fakeInstall()

    const targets = gitOverlayTargets(pathValue, git)

    expect(targets).toEqual(
      expect.arrayContaining([
        path.join(root, 'usr-bin', 'git'),
        path.join(root, 'local-bin', 'git'),
        path.join(git.core, 'git'),
        path.join(git.core, 'git-push'),
        path.join(git.core, 'git-send-pack'),
      ]),
    )
  })

  it('leaves out non-builtins, builtins the core lacks, and the shim itself', () => {
    const { git, pathValue } = fakeInstall()

    const targets = gitOverlayTargets(`${path.dirname(git.shim)}:${pathValue}`, git)

    expect(targets).not.toContain(path.join(git.core, 'git-remote-https'))
    expect(targets).not.toContain(path.join(git.core, 'git-stash'))
    expect(targets).not.toContain(git.shim)
  })

  it('never lists the real-git copy, even when its dir is on PATH or reached through a link', () => {
    const { git, pathValue, root } = fakeInstall()
    fs.mkdirSync(path.join(root, 'link-bin'))
    fs.symlinkSync(git.realCopy, path.join(root, 'link-bin', 'git'))

    const targets = gitOverlayTargets(`${path.join(root, 'link-bin')}:${pathValue}`, git)

    expect(targets).not.toContain(git.realCopy)
    expect(targets.map(t => fs.realpathSync(t))).not.toContain(fs.realpathSync(git.realCopy))
  })

  it('lists a git reached through two PATH spellings once', () => {
    const { git, root } = fakeInstall()
    fs.symlinkSync(path.join(root, 'usr-bin'), path.join(root, 'bin'))

    const targets = gitOverlayTargets(`${path.join(root, 'bin')}:${path.join(root, 'usr-bin')}`, git)

    expect(targets.filter(t => t === path.join(root, 'usr-bin', 'git'))).toHaveLength(1)
  })
})

describe('sandboxArgv (CC-1645 S2)', () => {
  it('keeps the host root, binds the shim read-only over each target, and ends its options', () => {
    const argv = sandboxArgv({ shim: '/s/git', targets: ['/usr/bin/git', '/core/git-push'] })

    expect(argv).toEqual([
      '--dev-bind',
      '/',
      '/',
      '--die-with-parent',
      '--ro-bind',
      '/s/git',
      '/usr/bin/git',
      '--ro-bind',
      '/s/git',
      '/core/git-push',
      '--',
    ])
  })

  it('binds a gh shim over its own targets when given one', () => {
    const argv = sandboxArgv({ shim: '/s/git', targets: [], ghShim: '/s/gh', ghTargets: ['/usr/bin/gh'] })

    expect(argv.slice(4, -1)).toEqual(['--ro-bind', '/s/gh', '/usr/bin/gh'])
  })

  it('names no shell, so no argument is ever parsed as command text', () => {
    const argv = sandboxArgv({ shim: '/s/git', targets: ['/usr/bin/git'] })

    expect(argv.filter(arg => ['sh', 'bash', 'zsh', 'dash', '-c'].includes(path.basename(arg)))).toEqual([])
  })
})

type Run = Parameters<typeof probeSandbox>[1]

const runReturning =
  (status: number | null, stderr = '', error?: Error): Run =>
  () =>
    ({ status, stderr, stdout: '', pid: 0, output: [], signal: null, error }) as ReturnType<NonNullable<Run>>

describe('probeSandbox (CC-1645 S2)', () => {
  const bwrapDir = (): string => {
    const dir = fs.mkdtempSync(path.join(SCRATCH, 'bwrap-'))
    writeExecutable(path.join(dir, 'bwrap'))
    return dir
  }

  it('reports bwrap missing when no PATH dir holds it', () => {
    expect(probeSandbox(fs.mkdtempSync(path.join(SCRATCH, 'empty-')), runReturning(0))).toEqual({
      ok: false,
      reason: 'bwrap not found on PATH',
    })
  })

  it('returns the resolved bwrap when a bound file runs', () => {
    const dir = bwrapDir()

    expect(probeSandbox(dir, runReturning(0))).toEqual({ ok: true, bwrap: path.join(dir, 'bwrap') })
  })

  it("carries bwrap's own refusal as the reason", () => {
    const result = probeSandbox(bwrapDir(), runReturning(1, 'bwrap: setting up uid map: Permission denied\n'))

    expect(result).toEqual({
      ok: false,
      reason: 'bwrap refused: bwrap: setting up uid map: Permission denied',
    })
  })

  it('reports a spawn failure', () => {
    const result = probeSandbox(bwrapDir(), runReturning(null, '', new Error('spawn EACCES')))

    expect(result).toEqual({ ok: false, reason: 'bwrap refused: spawn EACCES' })
  })
})
