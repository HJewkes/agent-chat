import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { findRealGit, gitShimDirFor, writeGitShim } from '../leak-guard/git-shim.js'
import { gitHooksEnv, noRewriteHooksDir } from '../leak-guard/hooks-dir.js'
import { HOST_PATH } from './helpers/git-shim-fixture.js'

/**
 * CC-1653: a broker restarted from an agent session had the shared shim dir first on its PATH, so
 * every no-rewrite shim baked that shim as its real git, and the shared shim refused each push
 * because the no-rewrite hooks dir is not its guard. The remote is non-local (127.0.0.1:<path>
 * through a fake ssh), so the shim's local-destination exemption does not hide the refusal.
 */

const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-shim-chain-')))
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }))

const REAL_GIT = findRealGit(HOST_PATH, path.join(SCRATCH, 'none')) as string

function writeExecutable(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}

describe('findRealGit with an agent-chat shim ahead of the real git', () => {
  it('returns the real git after a dir holding another agent-chat shim', () => {
    const fake = path.join(SCRATCH, 'other-shim')
    writeExecutable(path.join(fake, 'git'), '# Written by agent-chat at each spawn (TP-596).\nexit 99')
    const pathValue = `${fake}:${path.dirname(REAL_GIT)}`

    const found = findRealGit(pathValue, path.join(SCRATCH, 'own-shim'))

    expect(found).toBe(REAL_GIT)
  })

  it('still returns a plain script named git that agent-chat did not write', () => {
    const wrapper = path.join(SCRATCH, 'wrapper')
    writeExecutable(path.join(wrapper, 'git'), `exec '${REAL_GIT}' "$@"`)

    const found = findRealGit(`${wrapper}:${path.dirname(REAL_GIT)}`, path.join(SCRATCH, 'own-shim'))

    expect(found).toBe(path.join(wrapper, 'git'))
  })
})

describe('a no-rewrite shim written from a PATH with the shared shim first', () => {
  const chat = path.join(SCRATCH, 'chat')
  const sharedGuard = path.join(chat, 'git-hooks')
  const sharedShim = gitShimDirFor(sharedGuard)
  const guard = noRewriteHooksDir(sharedGuard)
  const shimDir = gitShimDirFor(guard)

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync(REAL_GIT, args, { cwd, encoding: 'utf8', env: { ...env(), PATH: HOST_PATH } }).trim()

  const env = (): NodeJS.ProcessEnv => ({
    PATH: `${shimDir}:${sharedShim}:${HOST_PATH}`,
    HOME: chat,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Probe',
    GIT_AUTHOR_EMAIL: 'probe@example.com',
    GIT_COMMITTER_NAME: 'Probe',
    GIT_COMMITTER_EMAIL: 'probe@example.com',
    ...gitHooksEnv(guard),
  })

  function repo(): string {
    const remote = path.join(SCRATCH, 'remote.git')
    const work = path.join(SCRATCH, 'work')
    git(SCRATCH, 'init', '-q', '--bare', '-b', 'main', remote)
    git(SCRATCH, 'init', '-q', '-b', 'main', work)
    git(work, 'commit', '-q', '--allow-empty', '-m', 'init')
    writeExecutable(path.join(SCRATCH, 'fake-ssh'), 'exec sh -c "$2"')
    git(work, 'config', 'core.sshCommand', path.join(SCRATCH, 'fake-ssh'))
    git(work, 'config', 'ssh.variant', 'simple')
    git(work, 'remote', 'add', 'origin', `127.0.0.1:${remote}`)
    return work
  }

  it("lets the agent's dry-run push to a non-local remote through the hooks-path check", () => {
    writeExecutable(path.join(guard, 'pre-push'), 'cat >/dev/null')
    expect(writeGitShim(sharedShim, sharedGuard, HOST_PATH)).toBe(true)
    expect(writeGitShim(shimDir, guard, `${sharedShim}:${HOST_PATH}`)).toBe(true)
    const work = repo()

    const push = spawnSync('sh', ['-c', 'git push --dry-run origin main'], {
      cwd: work,
      env: env(),
      encoding: 'utf8',
      timeout: 20_000,
    })

    expect(push.stderr).not.toContain('hooks-path')
    expect(push.status).toBe(0)
  })
})
