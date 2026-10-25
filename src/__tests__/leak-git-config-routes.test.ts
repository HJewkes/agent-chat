import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { findRealGit, writeGitShim } from '../leak-guard/git-shim.js'
import { gitHooksEnv, noRewriteHooksDir, termsFileFor, writeGitHooks } from '../leak-guard/hooks-dir.js'

/**
 * CC-1640: every route that sets git config around a push (-c, --config-env, exec -c, GIT_CONFIG_*
 * through a built name, GIT_CONFIG_PARAMETERS, a GIT_CONFIG_GLOBAL or GIT_CONFIG_SYSTEM file, an
 * include) run with real git. The remote is non-local (scp-style host:path), reached through a
 * fake ssh baked into the repo's config, so the shim's local-destination exemption does not apply.
 * Control: real git with the guard env and no shim lands the ref, so the route skips the guard's
 * hook. Guarded: the same line with the shim first on PATH lands nothing.
 */

const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-config-routes-')))
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }))

// Under an agent session the first git on PATH is that session's own shim; the control needs the real one.
const FIRST_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
const REAL_GIT = fs.readFileSync(FIRST_GIT, 'utf8').includes('Written by agent-chat')
  ? (findRealGit(process.env.PATH ?? '', path.dirname(FIRST_GIT)) ?? FIRST_GIT)
  : FIRST_GIT
const BASH = execFileSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim()
const REAL_PATH = `${path.dirname(REAL_GIT)}:/usr/bin:/bin`

const baseEnv = (): NodeJS.ProcessEnv => ({
  PATH: REAL_PATH,
  HOME: '/Users/example',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Probe',
  GIT_AUTHOR_EMAIL: 'probe@example.com',
  GIT_COMMITTER_NAME: 'Probe',
  GIT_COMMITTER_EMAIL: 'probe@example.com',
})

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(REAL_GIT, args, { cwd, env: baseEnv(), encoding: 'utf8' }).trim()

const GUARD_RAN = 'guard pre-push ran'

interface Fixture {
  work: string
  remote: string
  guard: string
  evil: string
  file: string
  shimDir: string
}

function writeExecutable(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}

/** A bare remote reached as 127.0.0.1:<path> through a fake ssh, and a guard dir whose hook refuses every push. */
function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(SCRATCH, 'repo-'))
  const at = (name: string): string => path.join(root, name)
  const [work, remote, guard, evil, shimDir] = ['work', 'remote.git', 'guard', 'evil', 'git-bin'].map(at) as [
    string,
    string,
    string,
    string,
    string,
  ]
  git(root, 'init', '-q', '--bare', '-b', 'main', remote)
  git(root, 'init', '-q', '-b', 'main', work)
  fs.writeFileSync(path.join(work, 'README.md'), 'r\n')
  git(work, 'add', 'README.md')
  git(work, 'commit', '-q', '-m', 'init')
  writeExecutable(at('fake-ssh'), 'exec sh -c "$2"')
  git(work, 'config', 'core.sshCommand', at('fake-ssh'))
  git(work, 'config', 'ssh.variant', 'simple')
  writeExecutable(path.join(guard, 'pre-push'), `echo '${GUARD_RAN}' >&2; exit 1`)
  fs.mkdirSync(evil)
  const file = at('crafted.cfg')
  fs.writeFileSync(file, `[core]\n\thooksPath = ${evil}\n`)
  writeGitShim(shimDir, guard, REAL_PATH)
  return { work, remote, guard, evil, file, shimDir }
}

/** One route: the bash line, built from the fixture's literal paths and the push it ends in. */
type Route = [string, (f: Fixture, push: string) => string]

const ROUTES: Route[] = [
  ['git -c core.hooksPath', (f, push) => push.replace('git push', `git -c core.hooksPath=${f.evil} push`)],
  [
    'git --config-env=core.hooksPath',
    (f, push) => `V=${f.evil} ${push.replace('git push', 'git --config-env=core.hooksPath=V push')}`,
  ],
  ['exec -c git push (bash clears the env)', (_f, push) => `exec -c ${push}`],
  [
    'export of a built GIT_CONFIG_VALUE_0 name',
    (f, push) => `n=GIT_CONFIG_VALUE_; export "\${n}0=${f.evil}"; ${push}`,
  ],
  ['declare -x of a built name', (f, push) => `n=GIT_CONFIG_VALUE_; declare -x "\${n}0=${f.evil}"; ${push}`],
  ['printf -v of a built name', (f, push) => `i=0; printf -v "GIT_CONFIG_VALUE_$i" %s ${f.evil}; ${push}`],
  ['read into a built name', (f, push) => `n=GIT_CONFIG_VALUE_0; read -r "$n" <<< ${f.evil}; ${push}`],
  ['for over GIT_CONFIG_VALUE_0', (f, push) => `for GIT_CONFIG_VALUE_0 in ${f.evil}; do ${push}; done`],
  ['getopts into GIT_CONFIG_COUNT', (_f, push) => `getopts 0 GIT_CONFIG_COUNT -0; ${push}`],
  ['(( GIT_CONFIG_COUNT = 0 ))', (_f, push) => `(( GIT_CONFIG_COUNT = 0 )); ${push}`],
  ['export of a built GIT_CONFIG_COUNT name', (_f, push) => `n=GIT_CONFIG_; export "\${n}COUNT=0"; ${push}`],
  [
    'export of a built GIT_CONFIG_KEY_0 name',
    (_f, push) => `n=GIT_CONFIG_KEY_; export "\${n}0=core.editor"; ${push}`,
  ],
  ['GIT_CONFIG_PARAMETERS', (f, push) => `GIT_CONFIG_PARAMETERS="'core.hookspath'='${f.evil}'" ${push}`],
  [
    'GIT_CONFIG_GLOBAL file, after a built-name GIT_CONFIG_COUNT=0',
    (f, push) => `n=GIT_CONFIG_; export "\${n}COUNT=0"; GIT_CONFIG_GLOBAL=${f.file} ${push}`,
  ],
  [
    'GIT_CONFIG_SYSTEM file, after a built-name GIT_CONFIG_COUNT=0',
    (f, push) => `n=GIT_CONFIG_; export "\${n}COUNT=0" "\${n}NOSYSTEM="; GIT_CONFIG_SYSTEM=${f.file} ${push}`,
  ],
  ['git -c include.path=<file>', (f, push) => push.replace('git push', `git -c include.path=${f.file} push`)],
]

const pushLine = (f: Fixture): string => `git push 127.0.0.1:${f.remote} HEAD:refs/heads/landed`

interface Outcome {
  landed: boolean
  stderr: string
}

function runLine(f: Fixture, line: string, shimmed: boolean): Outcome {
  const env = {
    ...baseEnv(),
    ...gitHooksEnv(f.guard),
    PATH: shimmed ? `${f.shimDir}:${REAL_PATH}` : REAL_PATH,
  }
  const out = spawnSync(BASH, ['-c', line], { cwd: f.work, env, encoding: 'utf8' })
  const ref = spawnSync(REAL_GIT, ['rev-parse', '--verify', '-q', 'refs/heads/landed'], {
    cwd: f.remote,
    env: baseEnv(),
    encoding: 'utf8',
  })
  return { landed: ref.status === 0, stderr: out.stderr }
}

describe('git config routes around a push, against real git (CC-1640)', () => {
  it('runs the guard hook for a plain push, so a landed ref means the route skipped it', () => {
    const f = fixture()

    const result = runLine(f, pushLine(f), false)

    expect(result.stderr).toContain(GUARD_RAN)
    expect(result.landed).toBe(false)
  })

  it.each(ROUTES)('%s: lands without the shim, and the shim refuses it', (_name, route) => {
    const control = fixture()
    const guarded = fixture()

    const bypass = runLine(control, route(control, pushLine(control)), false)
    const result = runLine(guarded, route(guarded, pushLine(guarded)), true)

    expect(bypass).toMatchObject({ landed: true })
    expect(result.stderr).toMatch(/git-shim: push refused \(hooks-path\)/)
    expect(result.landed).toBe(false)
  })
})

/** A local origin holding main and feat/x, with the broker's real hooks in `dir` and the shim first on PATH. */
interface GuardedRepo {
  work: string
  remote: string
  env: NodeJS.ProcessEnv
  scanEnv: string
}

function guardedRepo(noRewrite: boolean): GuardedRepo {
  const root = fs.mkdtempSync(path.join(SCRATCH, 'guarded-'))
  const at = (name: string): string => path.join(root, name)
  const [work, remote, owner, bin, scanEnv] = ['work', 'remote.git', 'owner', 'bin', 'scan-env'].map(at) as [
    string,
    string,
    string,
    string,
    string,
  ]
  git(root, 'init', '-q', '--bare', '-b', 'main', remote)
  git(root, 'init', '-q', '-b', 'main', work)
  git(work, 'remote', 'add', 'origin', remote)
  for (const [branch, file] of [
    ['main', 'README.md'],
    ['feat/x', 'x.md'],
  ] as const) {
    git(work, 'checkout', '-q', '-B', branch)
    fs.writeFileSync(path.join(work, file), `${file}\n`)
    git(work, 'add', file)
    git(work, 'commit', '-q', '-m', file)
  }
  git(work, 'push', '-q', 'origin', 'main', 'feat/x')
  fs.mkdirSync(path.dirname(termsFileFor(owner)), { recursive: true })
  fs.writeFileSync(termsFileFor(owner), 'zq7leakterm\n', { mode: 0o600 })
  fs.mkdirSync(bin)
  fs.symlinkSync(process.execPath, path.join(bin, 'node'))
  fs.symlinkSync(REAL_GIT, path.join(bin, 'git'))
  writeExecutable(
    path.join(bin, 'titan-egress-scan'),
    `[ "$1" = --help ] && { echo 'pre-push <remote>; files are scanned as text'; exit 0; }\nenv > ${scanEnv}\ncat >/dev/null\nexit 0`,
  )
  const shared = at('git-hooks')
  const hooks = noRewrite ? noRewriteHooksDir(shared) : shared
  writeGitHooks(hooks, { missingTermsRefuses: true, home: owner, path: `${bin}:/usr/bin:/bin` })
  const shimDir = at('git-bin')
  writeGitShim(shimDir, hooks, REAL_PATH)
  return {
    work,
    remote,
    env: { ...baseEnv(), ...gitHooksEnv(hooks), PATH: `${shimDir}:${REAL_PATH}` },
    scanEnv,
  }
}

const remoteRef = (repo: GuardedRepo, ref: string): string =>
  spawnSync(REAL_GIT, ['rev-parse', '--verify', '-q', ref], {
    cwd: repo.remote,
    env: baseEnv(),
    encoding: 'utf8',
  }).stdout.trim()

const pushConfigByLoop = (pairs: string): string =>
  `for n in GIT_CONFIG_COUNT=2 ${pairs}; do export "$n"; done; git push origin`

describe('GIT_CONFIG_* set through a name operand, with the hooks path left alone (CC-1640)', () => {
  it.each([
    [
      'remote.origin.mirror=true',
      'GIT_CONFIG_KEY_1=remote.origin.mirror GIT_CONFIG_VALUE_1=true',
      /is a mirror/,
    ],
    [
      'remote.origin.push=+HEAD:refs/heads/main',
      'GIT_CONFIG_KEY_1=remote.origin.push GIT_CONFIG_VALUE_1=+HEAD:refs/heads/main',
      /it updates refs\/heads\/main/,
    ],
  ])('the no-rewrite hook refuses a push whose config a for loop set to %s', (_name, pairs, why) => {
    const repo = guardedRepo(true)
    const before = ['refs/heads/main', 'refs/heads/feat/x'].map(ref => remoteRef(repo, ref))

    const out = spawnSync(BASH, ['-c', pushConfigByLoop(pairs)], {
      cwd: repo.work,
      env: repo.env,
      encoding: 'utf8',
    })

    expect(out.stderr).toMatch(why)
    expect(out.status).not.toBe(0)
    expect(['refs/heads/main', 'refs/heads/feat/x'].map(ref => remoteRef(repo, ref))).toEqual(before)
  })

  it('keeps every GIT_CONFIG_* variable out of the leak scanner', () => {
    const repo = guardedRepo(false)
    const line = `${pushConfigByLoop('GIT_CONFIG_KEY_1=core.sshCommand GIT_CONFIG_VALUE_1=false')} HEAD:refs/heads/feat/y`

    const out = spawnSync(BASH, ['-c', line], { cwd: repo.work, env: repo.env, encoding: 'utf8' })

    expect(out.status).toBe(0)
    expect(fs.readFileSync(repo.scanEnv, 'utf8')).not.toMatch(/^GIT_/m)
  })
})
