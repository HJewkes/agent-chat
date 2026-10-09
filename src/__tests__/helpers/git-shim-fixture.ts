import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect } from 'vitest'
import { findRealGit, writeGitShim } from '../../leak-guard/git-shim.js'
import { gitHooksEnv } from '../../leak-guard/hooks-dir.js'
import { expectSpawned } from './spawn-result.js'

export const NO_VERIFY = ['--no', 'verify'].join('-')

const isAgentShim = (dir: string): boolean => {
  try {
    return fs.readFileSync(path.join(dir, 'git'), 'utf8').includes('# Written by agent-chat')
  } catch {
    return false
  }
}

/** PATH without an agent session's own shim, so the shim under test never execs a second shim (CC-442). */
export const HOST_PATH = (process.env.PATH ?? '')
  .split(path.delimiter)
  .filter(dir => !isAgentShim(dir))
  .join(path.delimiter)

export interface GitShimFixture {
  work: string
  remote: string
  guard: string
  shimDir: string
  marker: string
  env: Record<string, string> & { PATH: string }
}

type ScriptRun = ReturnType<typeof spawnSync> & { stdout: string; stderr: string }

export interface GitShimHarness {
  scratch: string
  realGit: string
  git: (cwd: string, ...args: string[]) => string
  fixture: (shellAliases?: readonly string[]) => GitShimFixture
  runScript: (fx: GitShimFixture, body: string) => ScriptRun
  remoteHasMain: (fx: GitShimFixture) => boolean
}

/** A scratch dir removed after the file's tests, and fixtures whose only remote is a local bare repo. */
export function gitShimHarness(): GitShimHarness {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-git-shim-')))
  afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }))
  const realGit = findRealGit(HOST_PATH, path.join(scratch, 'none')) as string
  let count = 0

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync(realGit, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })

  /** A repo with one commit, a bare remote, a guard dir whose pre-push leaves a marker, and the shim. */
  function fixture(shellAliases: readonly string[] = []): GitShimFixture {
    const root = path.join(scratch, `case-${++count}`)
    const work = path.join(root, 'work')
    const remote = path.join(root, 'remote.git')
    const guard = path.join(root, 'git-hooks')
    const shimDir = path.join(root, 'git-bin')
    const home = path.join(root, 'home')
    const marker = path.join(root, 'pre-push-ran')
    for (const dir of [work, guard, home]) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(guard, 'pre-push'), `#!/bin/sh\ncat >/dev/null\ntouch '${marker}'\n`, {
      mode: 0o755,
    })
    git(root, 'init', '-q', '--bare', remote)
    git(work, 'init', '-q', '-b', 'main')
    git(
      work,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'one',
    )
    git(work, 'remote', 'add', 'origin', remote)
    git(work, 'remote', 'add', 'net', 'ssh://git.invalid/remote.git')
    expect(writeGitShim(shimDir, guard, HOST_PATH, shellAliases)).toBe(true)
    const env = {
      PATH: `${shimDir}:/usr/bin:/bin`,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_SSH_COMMAND: 'false',
      GIT_TERMINAL_PROMPT: '0',
      ...gitHooksEnv(guard),
    }
    return { work, remote, guard, shimDir, marker, env }
  }

  /** Runs a script file, as make or an npm script would; a recursing shim is killed by the timeout. */
  function runScript(fx: GitShimFixture, body: string): ScriptRun {
    const script = path.join(fx.work, '..', `script-${++count}.sh`)
    fs.writeFileSync(script, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return expectSpawned(
      spawnSync(script, { cwd: fx.work, env: fx.env, encoding: 'utf8', timeout: 10_000 }),
      body,
    )
  }

  const remoteHasMain = (fx: GitShimFixture): boolean =>
    spawnSync(realGit, ['--git-dir', fx.remote, 'rev-parse', '-q', '--verify', 'refs/heads/main']).status ===
    0

  return { scratch, realGit, git, fixture, runScript, remoteHasMain }
}
