import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { findRealGit, writeGitShim } from '../leak-guard/git-shim.js'
import { gitHooksEnv } from '../leak-guard/hooks-dir.js'

/** TP-783, against real git, a temp repo and a local bare remote; fixtures copied from leak-git-shim.test.ts. */

const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-git-shim-stash-')))

afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }))

const isAgentShim = (dir: string): boolean => {
  try {
    return fs.readFileSync(path.join(dir, 'git'), 'utf8').includes('# Written by agent-chat')
  } catch {
    return false
  }
}

const HOST_PATH = (process.env.PATH ?? '')
  .split(path.delimiter)
  .filter(dir => !isAgentShim(dir))
  .join(path.delimiter)

const REAL_GIT = findRealGit(HOST_PATH, path.join(SCRATCH, 'none')) as string
const NO_VERIFY = ['--no', 'verify'].join('-')
const IDENTITY =
  'GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com'

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(REAL_GIT, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })

interface Fixture {
  work: string
  remote: string
  env: Record<string, string> & { PATH: string }
}

let count = 0

/** A repo with one tracked file, a bare remote, a guard dir holding a pre-push hook, and the shim. */
function fixture(): Fixture {
  const root = path.join(SCRATCH, `case-${++count}`)
  const work = path.join(root, 'work')
  const remote = path.join(root, 'remote.git')
  const guard = path.join(root, 'git-hooks')
  const shimDir = path.join(root, 'git-bin')
  const home = path.join(root, 'home')
  for (const dir of [work, guard, home]) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(guard, 'pre-push'), '#!/bin/sh\ncat >/dev/null\n', { mode: 0o755 })
  git(root, 'init', '-q', '--bare', remote)
  git(work, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(work, 'file.txt'), 'one\n')
  git(work, 'add', 'file.txt')
  git(work, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'one')
  git(work, 'remote', 'add', 'origin', remote)
  expect(writeGitShim(shimDir, guard, HOST_PATH)).toBe(true)
  const env = {
    PATH: `${shimDir}:/usr/bin:/bin`,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...gitHooksEnv(guard),
  }
  return { work, remote, env }
}

function runScript(
  fx: Fixture,
  body: string,
): ReturnType<typeof spawnSync> & { stdout: string; stderr: string } {
  const script = path.join(fx.work, '..', `script-${++count}.sh`)
  fs.writeFileSync(script, `#!/bin/sh\nexport ${IDENTITY}\n${body}\n`, { mode: 0o755 })
  return spawnSync(script, { cwd: fx.work, env: fx.env, encoding: 'utf8', timeout: 10_000 })
}

const remoteHasMain = (fx: Fixture): boolean =>
  spawnSync(REAL_GIT, ['--git-dir', fx.remote, 'rev-parse', '-q', '--verify', 'refs/heads/main']).status === 0

describe('the agent git shim exempting only an exact git stash push (TP-783)', () => {
  // Kills: the exemption reverted to any token after stash, and an exemption that covers the rest of the line.
  it.each([
    `!git stash push;git\${IFS}push ${NO_VERIFY} origin main`,
    `!git stash ;git\${IFS}push ${NO_VERIFY} origin main`,
    `!git stash; git push ${NO_VERIFY} origin main`,
    `!git stash push && git push ${NO_VERIFY} origin main`,
    `!git stash push\ngit push ${NO_VERIFY} origin main`,
    `!git stash push $(git push ${NO_VERIFY} origin main)`,
  ])('refuses the shell alias %s, whose later command pushes', alias => {
    const fx = fixture()
    git(fx.work, 'config', 'alias.g', alias)

    const run = runScript(fx, 'git g')

    expect(run.stderr).toContain('git-shim: push refused (shell-alias)')
    expect(run.status).toBe(2)
    expect(remoteHasMain(fx)).toBe(false)
  })

  // Kills: an option value of stash taken as the stash subcommand (reviewer finding Q1 on #332).
  it.each(['-C stash', '--work-tree stash', '--namespace stash', '--git-dir=stash'])(
    'refuses the shell alias !git %s push, where stash is an option value',
    options => {
      const fx = fixture()
      fs.mkdirSync(path.join(fx.work, 'stash'))
      git(fx.work, 'config', 'alias.g', `!git ${options} push ${NO_VERIFY} origin main`)

      const run = runScript(fx, 'git g')

      expect(run.stderr).toContain('git-shim: push refused (shell-alias)')
      expect(run.status).toBe(2)
      expect(remoteHasMain(fx)).toBe(false)
    },
  )

  // Kills: the stash exemption removed, or global options not skipped before the subcommand.
  it.each([
    ['git stash push -m x', ''],
    ['git g', '!git stash push -m x'],
    ['git g', '!git -C sub stash push -m x'],
  ])('still runs %s (alias %s) and records the stash', (command, alias) => {
    const fx = fixture()
    fs.mkdirSync(path.join(fx.work, 'sub'))
    if (alias) git(fx.work, 'config', 'alias.g', alias)
    fs.writeFileSync(path.join(fx.work, 'file.txt'), 'two\n')

    const run = runScript(fx, command)

    expect(run.stderr).not.toContain('git-shim')
    expect(run.status).toBe(0)
    expect(git(fx.work, 'stash', 'list')).toContain(': x')
  })
})

describe('the agent git shim naming a typo it refuses under help.autocorrect (TP-783)', () => {
  // Kills: the refusal for a typo that git would not correct to push still saying push refused.
  it('names git stauts as the typo and does not claim a push', () => {
    const fx = fixture()

    const run = runScript(fx, 'git -c help.autocorrect=1 stauts')

    expect(run.stderr).toContain("git-shim: refused (autocorrect): 'stauts' is not a git command")
    expect(run.stderr).not.toContain('push refused')
    expect(run.status).toBe(2)
  })

  it('still names a push when git would correct the typo to push', () => {
    const fx = fixture()

    const run = runScript(fx, `git -c help.autocorrect=1 pusj origin main ${NO_VERIFY}`)

    expect(run.stderr).toContain('git-shim: push refused (autocorrect): pusj')
    expect(run.status).toBe(2)
    expect(remoteHasMain(fx)).toBe(false)
  })
})
