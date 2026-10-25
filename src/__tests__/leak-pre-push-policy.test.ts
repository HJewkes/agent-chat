import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { gitShimDirFor, writeGitShim } from '../leak-guard/git-shim.js'
import { gitHooksEnv, noRewriteHooksDir, termsFileFor, writeGitHooks } from '../leak-guard/hooks-dir.js'

/**
 * The no-rewrite push policy in the pre-push hook (CC-1633), run against real git and a local bare
 * origin. git hands the hook the ref updates it is about to make after config, includes, HOME,
 * mirror, push.default and the dashed `git-push` name are resolved, so each route lands on the
 * same lines. The policy is baked into the no-rewrite hooks dir, so no variable switches it off.
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
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Probe',
  GIT_AUTHOR_EMAIL: 'probe@example.com',
  GIT_COMMITTER_NAME: 'Probe',
  GIT_COMMITTER_EMAIL: 'probe@example.com',
})

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env: baseEnv(), encoding: 'utf8' }).trim()

interface Fixture {
  root: string
  work: string
  remote: string
  hooks: string
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

type Dir = 'no-rewrite' | 'default'

/** main and feat/x on the origin, the work repo on feat/x, and git pointed at the chosen guard dir. */
function fixture(dir: Dir = 'no-rewrite'): Fixture {
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
  const shared = path.join(root, 'chat', 'git-hooks')
  const hooks = dir === 'no-rewrite' ? noRewriteHooksDir(shared) : shared
  writeGitHooks(hooks, { missingTermsRefuses: true, home: owner, path: scanPath(root) })
  return { root, work, remote, hooks, agentEnv: { ...baseEnv(), ...gitHooksEnv(hooks) } }
}

/** What a route runs once its setup is done; env entries set to undefined are removed. */
interface Push {
  args: string[]
  program?: string
  env?: Record<string, string | undefined>
}

interface Outcome {
  code: number
  stderr: string
}

/** How the agent's shell might try to switch the old env-gated policy off; nothing reads the variable now. */
type Variant = [string, (push: Push) => Push]

const POLICY_VAR = 'AGENT_CHAT_PUSH_POLICY'

const throughSh = (script: string, push: Push): Push => ({
  ...push,
  program: 'sh',
  args: ['-c', `${script}; exec "$@"`, 'sh', push.program ?? 'git', ...push.args],
})

const VARIANTS: Variant[] = [
  ['as launched', push => push],
  [`with ${POLICY_VAR}=off`, push => ({ ...push, env: { ...push.env, [POLICY_VAR]: 'off' } })],
  ['after a for rewrite', push => throughSh(`for ${POLICY_VAR} in off; do export ${POLICY_VAR}; done`, push)],
  [
    'after a read rewrite',
    push => throughSh(`read -r ${POLICY_VAR} <<EOF\noff\nEOF\nexport ${POLICY_VAR}`, push),
  ],
]

function run(f: Fixture, push: Push): Outcome {
  const env = { ...f.agentEnv, ...push.env }
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key]
  const out = spawnSync(push.program ?? 'git', push.args, { cwd: f.work, env, encoding: 'utf8' })
  return { code: out.status ?? -1, stderr: out.stderr }
}

const remoteAt = (f: Fixture, ref: string): string =>
  spawnSync('git', ['rev-parse', '--verify', '-q', ref], {
    cwd: f.remote,
    env: baseEnv(),
    encoding: 'utf8',
  }).stdout.trim()

const GUARDED = ['refs/heads/main', 'refs/heads/feat/x']
const origin = (f: Fixture): string[] => GUARDED.map(ref => remoteAt(f, ref))

const REFUSED = /push refused by the no-rewrite push policy/

const DELETES = /: it deletes refs\/heads\/feat\/x;/
const MIRROR = /: remote (origin|m) is a mirror/
const MAIN = /: it updates refs\/heads\/main;/
const NOT_FF = /: refs\/heads\/feat\/x is not a fast-forward/
const NAMESPACE = /: refs\/remotes\/origin\/\S+ is outside refs\/heads\/ and refs\/tags\//

/** Each route sets up a fresh fixture and names the push; the origin must be as it was before. */
type Route = [string, RegExp, (f: Fixture) => Push]

const ROUTES: Route[] = [
  [
    '-c remote.origin.mirror=true push origin, which would prune feat/x',
    MIRROR,
    f => {
      dropFeatX(f)
      return { args: ['-c', 'remote.origin.mirror=true', 'push', 'origin'] }
    },
  ],
  [
    '-c remote.origin.push=:refs/heads/feat/x push origin',
    DELETES,
    () => ({ args: ['-c', 'remote.origin.push=:refs/heads/feat/x', 'push', 'origin'] }),
  ],
  [
    '-c remote.origin.push=+HEAD:refs/heads/main push origin',
    MAIN,
    () => ({ args: ['-c', 'remote.origin.push=+HEAD:refs/heads/main', 'push', 'origin'] }),
  ],
  [
    '-c push.default=matching push origin, with main ahead',
    MAIN,
    f => {
      commit(f.work, 'main', 'ahead.md')
      return { args: ['-c', 'push.default=matching', 'push', 'origin'] }
    },
  ],
  [
    '--config-env=remote.origin.mirror=V push origin',
    MIRROR,
    f => {
      dropFeatX(f)
      return { args: ['--config-env=remote.origin.mirror=V', 'push', 'origin'], env: { V: 'true' } }
    },
  ],
  [
    '-c include.path=<file setting remote.origin.mirror> push origin',
    MIRROR,
    f => {
      dropFeatX(f)
      return { args: ['-c', `include.path=${included(f, MIRROR_CONFIG)}`, 'push', 'origin'] }
    },
  ],
  [
    'git config include.path <file pushing feat/x to main>, then git push origin',
    MAIN,
    f => {
      git(
        f.work,
        'config',
        'include.path',
        included(f, '[remote "origin"]\n\tpush = +refs/heads/feat/x:refs/heads/main\n'),
      )
      return { args: ['push', 'origin'] }
    },
  ],
  [
    'HOME=<dir whose .gitconfig sets remote.origin.mirror> git push origin',
    MIRROR,
    f => {
      dropFeatX(f)
      const home = path.join(f.root, 'swapped-home')
      fs.mkdirSync(home)
      fs.writeFileSync(path.join(home, '.gitconfig'), MIRROR_CONFIG)
      return { args: ['push', 'origin'], env: { HOME: home, GIT_CONFIG_GLOBAL: undefined } }
    },
  ],
  [
    'git remote add --mirror=push m <origin>, then git push m',
    MIRROR,
    f => {
      dropFeatX(f)
      git(f.work, 'remote', 'add', '--mirror=push', 'm', f.remote)
      return { args: ['push', 'm'] }
    },
  ],
  [
    "git push origin 'refs/heads/*:refs/heads/*', with main ahead",
    MAIN,
    f => {
      commit(f.work, 'main', 'ahead.md')
      return { args: ['push', 'origin', 'refs/heads/*:refs/heads/*'] }
    },
  ],
  [
    '$(git --exec-path)/git-push origin --delete feat/x',
    DELETES,
    () => ({ args: ['origin', '--delete', 'feat/x'], program: dashedPush() }),
  ],
  [
    'a .git/config push = +refs/heads/*:refs/heads/* edit, then git push origin over a rewritten feat/x',
    NOT_FF,
    f => {
      rewriteFeatX(f)
      fs.appendFileSync(
        path.join(f.work, '.git', 'config'),
        '[remote "origin"]\n\tpush = +refs/heads/*:refs/heads/*\n',
      )
      return { args: ['push', 'origin'] }
    },
  ],
  [
    'git push --force origin feat/x, not a fast-forward',
    NOT_FF,
    f => {
      rewriteFeatX(f)
      return { args: ['push', '--force', 'origin', 'feat/x'] }
    },
  ],
  [
    'git push --mirror origin, which would prune feat/x',
    NAMESPACE,
    f => {
      dropFeatX(f)
      return { args: ['push', '--mirror', 'origin'] }
    },
  ],
  [
    "git push --prune origin 'refs/heads/*:refs/heads/*', which would prune feat/x",
    DELETES,
    f => {
      dropFeatX(f)
      return { args: ['push', '--prune', 'origin', 'refs/heads/*:refs/heads/*'] }
    },
  ],
]

const MIRROR_CONFIG = '[remote "origin"]\n\tmirror = true\n'

/** feat/x gone locally, so a mirror or prune push would delete it on the origin. */
function dropFeatX(f: Fixture): void {
  git(f.work, 'checkout', '-q', 'main')
  git(f.work, 'branch', '-D', 'feat/x')
}

/** feat/x rebuilt from main, so pushing it is not a fast-forward of the origin's feat/x. */
function rewriteFeatX(f: Fixture): void {
  git(f.work, 'checkout', '-q', 'main')
  commit(f.work, 'feat/x', 'rewritten.md')
}

function included(f: Fixture, text: string): string {
  const file = path.join(f.root, 'included.cfg')
  fs.writeFileSync(file, text)
  return file
}

function dashedPush(): string {
  const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim()
  return path.join(execPath, 'git-push')
}

const CASES = ROUTES.flatMap(([name, why, route]) =>
  VARIANTS.map(([variant, wrap]) => [`${name}, ${variant}`, why, route, wrap] as const),
)

describe('pre-push no-rewrite policy against real git (CC-1633)', () => {
  it.each(CASES)('refuses %s, leaving the origin as it was', (_name, why, route, wrap) => {
    const f = fixture()
    const before = origin(f)

    const result = run(f, wrap(route(f)))

    expect(result.stderr).toMatch(REFUSED)
    expect(result.stderr).toMatch(why)
    expect(result.code).not.toBe(0)
    expect(origin(f)).toEqual(before)
  })

  it('lets a new branch and a fast-forward of an agent branch through', () => {
    const f = fixture()
    commit(f.work, 'feat/x', 'more.md')
    commit(f.work, 'feat/y', 'y.md')

    const result = run(f, { args: ['push', 'origin', 'feat/x', 'feat/y'] })

    expect(result).toMatchObject({ code: 0 })
    expect(remoteAt(f, 'refs/heads/feat/x')).toBe(git(f.work, 'rev-parse', 'feat/x'))
    expect(remoteAt(f, 'refs/heads/feat/y')).toBe(git(f.work, 'rev-parse', 'feat/y'))
  })

  it("leaves a default-dir agent's delete to the leak scan alone", () => {
    const f = fixture('default')

    const result = run(f, { args: ['push', 'origin', '--delete', 'feat/x'] })

    expect(result).toMatchObject({ code: 0 })
    expect(remoteAt(f, 'refs/heads/feat/x')).toBe('')
  })

  it.each([
    ['-c remote.origin.mirror=true push origin', ['-c', 'remote.origin.mirror=true', 'push', 'origin']],
    ['push --mirror origin', ['push', '--mirror', 'origin']],
    [
      "push --prune origin 'refs/heads/*:refs/heads/*'",
      ['push', '--prune', 'origin', 'refs/heads/*:refs/heads/*'],
    ],
  ])('lets a default-dir agent %s prune feat/x, so those rows test the policy', (_name, args) => {
    const f = fixture('default')
    dropFeatX(f)

    const result = run(f, { args })

    expect(result).toMatchObject({ code: 0 })
    expect(remoteAt(f, 'refs/heads/feat/x')).toBe('')
  })

  it("has the no-rewrite dir's git shim refuse a push whose resolved core.hooksPath is another dir", () => {
    const f = fixture()
    const shimDir = gitShimDirFor(f.hooks)
    writeGitShim(shimDir, f.hooks, `${path.dirname(REAL_GIT)}:/usr/bin:/bin`)
    git(f.work, 'remote', 'add', 'far', 'https://127.0.0.1:9/r.git')
    const shared = path.dirname(f.hooks)

    const result = run(f, {
      args: ['-c', `core.hooksPath=${shared}`, 'push', 'far', '--delete', 'feat/x'],
      program: path.join(shimDir, 'git'),
    })

    expect(shimDir).toBe(path.join(shared, 'git-bin'))
    expect(result.stderr).toMatch(/git-shim: push refused \(hooks-path\)/)
    expect(result.code).not.toBe(0)
  })
})
