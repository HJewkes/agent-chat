import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ghShimScript } from '../gh-shim/install.js'
import { findRealGit, gitShimScript } from '../leak-guard/git-shim.js'
import { gitHooksEnv, hookScripts, writeGitHooks } from '../leak-guard/hooks-dir.js'
import { ENVIRONMENT_SCRUB, hardenedShebang, posixShell } from '../leak-guard/posix-shell.js'

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-posix-shell-'))
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }))

const isAgentShim = (dir: string): boolean => {
  try {
    return fs.readFileSync(path.join(dir, 'git'), 'utf8').includes('# Written by agent-chat')
  } catch {
    return false
  }
}

// The live agent git shim may lead PATH; a test against it would run through its own bash -p layer.
const HOST_PATH = (process.env.PATH ?? '')
  .split(path.delimiter)
  .filter(dir => !isAgentShim(dir))
  .join(path.delimiter)

const REAL_GIT = findRealGit(HOST_PATH, path.join(SCRATCH, 'none')) as string
const INPUTS = { missingTermsRefuses: true, home: SCRATCH, path: '/usr/bin:/bin' }
// /bin/sh is bash on macOS and dash on Ubuntu; /bin/bash adds a bash-backed pass wherever sh is not.
const SHELLS = ['/bin/dash', '/bin/sh', '/bin/bash'].filter(shell => fs.existsSync(shell))
const firstLine = (script: string): string => script.split('\n')[0] ?? ''

describe('posixShell', () => {
  it('names dash when it is an executable file', () => {
    expect(posixShell(file => file === '/bin/dash')).toBe('/bin/dash')
  })

  it('falls back to /bin/sh when dash is missing, never to nothing', () => {
    expect(posixShell(() => false)).toBe('/bin/sh')
  })

  it('falls back to /bin/sh when the probe throws', () => {
    expect(
      posixShell(() => {
        throw new Error('stat failed')
      }),
    ).toBe('/bin/sh')
  })

  it('treats a directory or a non-executable file at /bin/dash as missing', () => {
    expect(posixShell(file => file !== '/bin/dash')).toBe('/bin/sh')
  })
})

describe.each(SHELLS.map(shell => [path.basename(shell), shell]))(
  'generated scripts written for %s',
  (_name, shell) => {
    const scripts = (): { gitShim: string; prePush: string; chain: string; gh: string } => ({
      gitShim: gitShimScript(REAL_GIT, SCRATCH, [], '', shell),
      prePush: hookScripts(INPUTS, shell).get('pre-push') ?? '',
      chain: hookScripts(INPUTS, shell).get('pre-commit') ?? '',
      gh: ghShimScript(SCRATCH, '/node', '/main.js', shell),
    })

    it('names the fixed interpreter on line 1, with -p wherever the interpreter takes it', () => {
      const { gitShim, prePush, chain, gh } = scripts()
      const hardened = hardenedShebang(shell)

      expect([firstLine(gitShim), firstLine(prePush)]).toEqual([hardened, hardened])
      expect(firstLine(chain)).toBe(`#!${shell}`)
      expect(firstLine(gh)).toBe(`#!${shell}`)
      expect(hardened.endsWith(' -p')).toBe(shell !== '/bin/dash')
    })

    it('scrubs SHELLOPTS the same way in the shim, chain hook and pre-push, whatever the interpreter', () => {
      const { gitShim, prePush, chain } = scripts()

      for (const script of [gitShim, prePush, chain]) expect(script).toContain(ENVIRONMENT_SCRUB)
    })

    it('looks the repo hook up without env, in a subshell that unsets GIT_CONFIG_COUNT', () => {
      const { chain, prePush } = scripts()

      for (const script of [chain, prePush]) {
        expect(script).not.toContain('env -u')
        expect(script).toContain('own=$(unset GIT_CONFIG_COUNT; git rev-parse --git-path hooks 2>/dev/null)')
      }
    })
  },
)

describe.each(SHELLS)('the git shim under %s', shell => {
  it('refuses a push that skips verification and fails with its message intact', () => {
    const bin = path.join(SCRATCH, `bin-${path.basename(shell)}`)
    fs.mkdirSync(bin, { recursive: true })
    const shim = path.join(bin, 'git')
    fs.writeFileSync(shim, gitShimScript(REAL_GIT, SCRATCH, [], '', shell), { mode: 0o755 })

    const run = spawnSync(shim, ['push', '--no-verify'], { cwd: SCRATCH, encoding: 'utf8' })

    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain('git-shim: push refused (no-verify)')
  })
})

describe('a chain hook counting the commands it runs from PATH', () => {
  let repo: string
  let log: string
  let env: Record<string, string>

  beforeAll(() => {
    repo = path.join(SCRATCH, 'repo')
    fs.mkdirSync(repo)
    execFileSync(REAL_GIT, ['init', '-q', repo])
    const stubs = path.join(SCRATCH, 'stubs')
    fs.mkdirSync(stubs)
    log = path.join(SCRATCH, 'path-commands.log')
    const realEnv = execFileSync('/usr/bin/which', ['env'], { encoding: 'utf8' }).trim()
    const stubbed: [string, string][] = [
      ['git', REAL_GIT],
      ['env', realEnv],
    ]
    for (const [name, real] of stubbed) {
      fs.writeFileSync(path.join(stubs, name), `#!/bin/sh\necho ${name} >> '${log}'\nexec '${real}' "$@"\n`, {
        mode: 0o755,
      })
    }
    env = { PATH: `${stubs}:/usr/bin:/bin` }
  })

  it.each(SHELLS)('runs exactly one PATH command, git, under %s', shell => {
    const hooks = path.join(SCRATCH, `hooks-${path.basename(shell)}`)
    writeGitHooks(hooks, INPUTS, shell)
    fs.rmSync(log, { force: true })

    const run = spawnSync(path.join(hooks, 'pre-commit'), [], { cwd: repo, env, encoding: 'utf8' })

    expect(run.status).toBe(0)
    expect(fs.readFileSync(log, 'utf8').trim().split('\n')).toEqual(['git'])
  })

  it('is not steered by ENV or SHELLOPTS in the agent environment', () => {
    const marker = path.join(SCRATCH, 'env-ran')
    const envFile = path.join(SCRATCH, 'envfile')
    fs.writeFileSync(envFile, `touch '${marker}'\n`)
    const hooks = path.join(SCRATCH, 'hooks-hostile')
    writeGitHooks(hooks, INPUTS)

    const run = spawnSync(path.join(hooks, 'pre-commit'), [], {
      cwd: repo,
      env: { ...env, ENV: envFile, BASH_ENV: envFile, SHELLOPTS: 'xtrace' },
      encoding: 'utf8',
    })

    expect(run.status).toBe(0)
    expect(fs.existsSync(marker)).toBe(false)
  })
})

describe.each(SHELLS)('a commit through the git shim on %s under a hostile SHELLOPTS', shell => {
  it.each(['#!/bin/sh', '#!/bin/bash'])('still runs a refusing %s repo pre-commit hook', shebang => {
    const root = fs.mkdtempSync(path.join(SCRATCH, 'commit-'))
    const repo = path.join(root, 'repo')
    const guard = path.join(root, 'git-hooks')
    const marker = path.join(root, 'hook-ran')
    const shim = path.join(root, 'git')
    const identity = {
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    }
    const clean = {
      PATH: HOST_PATH,
      HOME: root,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      ...identity,
    }
    execFileSync(REAL_GIT, ['init', '-q', repo], { env: clean })
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
    execFileSync(REAL_GIT, ['add', 'a.txt'], { cwd: repo, env: clean })
    fs.writeFileSync(
      path.join(repo, '.git', 'hooks', 'pre-commit'),
      `${shebang}\necho ran >> '${marker}'\nexit 1\n`,
      {
        mode: 0o755,
      },
    )
    writeGitHooks(guard, INPUTS, shell)
    fs.writeFileSync(shim, gitShimScript(REAL_GIT, guard, [], '', shell), { mode: 0o755 })

    const run = spawnSync(shim, ['commit', '-q', '-m', 'x'], {
      cwd: repo,
      env: { ...clean, ...gitHooksEnv(guard), SHELLOPTS: 'noexec', BASH_VERSION: '5.2.0' },
      encoding: 'utf8',
    })

    expect(fs.existsSync(marker)).toBe(true)
    expect(run.status).not.toBe(0)
  })
})
