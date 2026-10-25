import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { gitHooksEnv, termsFileFor, writeGitHooks } from '../leak-guard/hooks-dir.js'

/**
 * The no-rewrite push policy in the pre-push hook (CC-1633), run against real git and a local bare
 * origin. git hands the hook the ref updates it is about to make after config, includes, mirror,
 * push.default and the dashed `git-push` name are resolved, so each route lands on the same lines.
 */

const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-push-policy-')))
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }))

const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()

// A scanner that finds nothing, so only the policy decides.
const CLEAN_SCANNER = `[ "$1" = --help ] && { echo 'pre-push <remote>; files are scanned as text'; exit 0; }
cat >/dev/null
exit 0`

const baseEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: '/Users/example',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Probe',
  GIT_AUTHOR_EMAIL: 'probe@example.com',
  GIT_COMMITTER_NAME: 'Probe',
  GIT_COMMITTER_EMAIL: 'probe@example.com',
})

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env: baseEnv(), encoding: 'utf8' }).trim()

interface Fixture {
  work: string
  remote: string
  agentEnv: NodeJS.ProcessEnv
}

function scanPath(root: string): string {
  const bin = path.join(root, 'bin')
  fs.mkdirSync(bin)
  fs.symlinkSync(process.execPath, path.join(bin, 'node'))
  fs.symlinkSync(REAL_GIT, path.join(bin, 'git'))
  fs.writeFileSync(path.join(bin, 'titan-egress-scan'), `#!/bin/sh\n${CLEAN_SCANNER}\n`, { mode: 0o755 })
  return `${bin}:/usr/bin:/bin`
}

function commit(work: string, branch: string, file: string): void {
  git(work, 'checkout', '-q', '-B', branch)
  fs.writeFileSync(path.join(work, file), `${file}\n`)
  git(work, 'add', file)
  git(work, 'commit', '-q', '-m', `add ${file}`)
}

/** main and feat/x on the origin, the work repo on feat/x, and the guard hooks with the policy set. */
function fixture(policy: string | null = 'no-rewrite'): Fixture {
  const root = fs.mkdtempSync(path.join(SCRATCH, 'repo-'))
  const [work, remote, owner] = ['work', 'remote.git', 'owner'].map(d => path.join(root, d)) as [
    string,
    string,
    string,
  ]
  git(root, 'init', '-q', '--bare', '-b', 'main', remote)
  git(root, 'init', '-q', '-b', 'main', work)
  git(work, 'remote', 'add', 'origin', remote)
  commit(work, 'main', 'README.md')
  commit(work, 'feat/x', 'x.md')
  git(work, 'push', '-q', 'origin', 'main', 'feat/x')
  fs.mkdirSync(path.dirname(termsFileFor(owner)), { recursive: true })
  fs.writeFileSync(termsFileFor(owner), 'zq7leakterm\n', { mode: 0o600 })
  const hooks = path.join(root, 'chat', 'git-hooks')
  writeGitHooks(hooks, { missingTermsRefuses: true, home: owner, path: scanPath(root) })
  const agentEnv = {
    ...baseEnv(),
    ...gitHooksEnv(hooks),
    ...(policy === null ? {} : { AGENT_CHAT_PUSH_POLICY: policy }),
  }
  return { work, remote, agentEnv }
}

function run(f: Fixture, args: string[], program = 'git'): { code: number; stderr: string } {
  const out = spawnSync(program, args, { cwd: f.work, env: f.agentEnv, encoding: 'utf8' })
  return { code: out.status ?? -1, stderr: out.stderr }
}

const remoteAt = (f: Fixture, ref: string): string =>
  spawnSync('git', ['rev-parse', '--verify', '-q', ref], {
    cwd: f.remote,
    env: baseEnv(),
    encoding: 'utf8',
  }).stdout.trim()

const REFUSED = /push refused by the no-rewrite push policy/

/** Each route runs once on a fresh fixture; the origin must be as it was before. */
type Route = [string, RegExp, (f: Fixture) => { code: number; stderr: string }]

const DELETES = /: it deletes refs\/heads\/feat\/x;/
const MIRROR = /: remote origin is a mirror/
const MAIN = /: it updates refs\/heads\/main;/
const NOT_FF = /: refs\/heads\/feat\/x is not a fast-forward/

const ROUTES: Route[] = [
  ['git push origin --delete feat/x', DELETES, f => run(f, ['push', 'origin', '--delete', 'feat/x'])],
  [
    'dashed git-push origin --delete feat/x',
    DELETES,
    f => run(f, ['origin', '--delete', 'feat/x'], dashedPush()),
  ],
  [
    'git -c remote.origin.mirror=true push origin, which would prune feat/x',
    MIRROR,
    f => {
      dropFeatX(f)
      return run(f, ['-c', 'remote.origin.mirror=true', 'push', 'origin'])
    },
  ],
  [
    'git -c include.path=<file setting remote.origin.mirror> push origin',
    MIRROR,
    f => {
      dropFeatX(f)
      return run(f, [
        '-c',
        `include.path=${included(f, '[remote "origin"]\n\tmirror = true\n')}`,
        'push',
        'origin',
      ])
    },
  ],
  [
    'git config remote.origin.mirror true, then git push origin',
    MIRROR,
    f => {
      dropFeatX(f)
      git(f.work, 'config', 'remote.origin.mirror', 'true')
      return run(f, ['push', 'origin'])
    },
  ],
  [
    'git -c remote.origin.push=+HEAD:refs/heads/main push origin',
    MAIN,
    f => run(f, ['-c', 'remote.origin.push=+HEAD:refs/heads/main', 'push', 'origin']),
  ],
  [
    'git -c include.path=<file setting remote.origin.push to main> push origin',
    MAIN,
    f => {
      const file = included(f, '[remote "origin"]\n\tpush = +refs/heads/feat/x:refs/heads/main\n')
      return run(f, ['-c', `include.path=${file}`, 'push', 'origin'])
    },
  ],
  [
    'git -c push.default=matching push origin, with main ahead',
    MAIN,
    f => {
      commit(f.work, 'main', 'ahead.md')
      return run(f, ['-c', 'push.default=matching', 'push', 'origin'])
    },
  ],
  [
    'a forced non-fast-forward of feat/x',
    NOT_FF,
    f => {
      git(f.work, 'reset', '-q', '--hard', 'main')
      commit(f.work, 'feat/x', 'rewritten.md')
      return run(f, ['push', '--force', 'origin', 'feat/x'])
    },
  ],
]

/** feat/x gone locally, so a mirror push would delete it on the origin. */
function dropFeatX(f: Fixture): void {
  git(f.work, 'checkout', '-q', 'main')
  git(f.work, 'branch', '-D', 'feat/x')
}

function included(f: Fixture, text: string): string {
  const file = path.join(f.work, '..', 'included.cfg')
  fs.writeFileSync(file, text)
  return file
}

function dashedPush(): string {
  const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
  return path.join(execPath, 'git-push')
}

describe('pre-push no-rewrite policy against real git (CC-1633)', () => {
  it.each(ROUTES)('refuses %s and leaves the origin as it was', (_name, why, route) => {
    const f = fixture()
    const before = ['refs/heads/main', 'refs/heads/feat/x'].map(ref => remoteAt(f, ref))

    const result = route(f)

    expect(result.stderr).toMatch(REFUSED)
    expect(result.stderr).toMatch(why)
    expect(result.code).not.toBe(0)
    expect(['refs/heads/main', 'refs/heads/feat/x'].map(ref => remoteAt(f, ref))).toEqual(before)
  })

  it('lets a new branch and a fast-forward of an agent branch through', () => {
    const f = fixture()
    commit(f.work, 'feat/x', 'more.md')
    commit(f.work, 'feat/y', 'y.md')

    const result = run(f, ['push', 'origin', 'feat/x', 'feat/y'])

    expect(result).toMatchObject({ code: 0 })
    expect(remoteAt(f, 'refs/heads/feat/x')).toBe(git(f.work, 'rev-parse', 'feat/x'))
    expect(remoteAt(f, 'refs/heads/feat/y')).toBe(git(f.work, 'rev-parse', 'feat/y'))
  })

  it.each([null, 'off'])('leaves a delete alone when the policy is %s', policy => {
    const f = fixture(policy)

    const result = run(f, ['push', 'origin', '--delete', 'feat/x'])

    expect(result).toMatchObject({ code: 0 })
    expect(remoteAt(f, 'refs/heads/feat/x')).toBe('')
  })

  it('lets a mirror push prune without the policy, so the mirror rows test the policy', () => {
    const f = fixture(null)
    dropFeatX(f)

    const result = run(f, ['-c', 'remote.origin.mirror=true', 'push', 'origin'])

    expect(result).toMatchObject({ code: 0 })
    expect(remoteAt(f, 'refs/heads/feat/x')).toBe('')
  })
})
