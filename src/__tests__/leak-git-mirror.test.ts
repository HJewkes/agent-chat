import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { withShims } from '../agents/launch-agent.js'
import type { LaunchPlan } from '../agents/types.js'
import { gitMirrorDirFor, mirrorEntries } from '../leak-guard/git-mirror.js'
import { GIT_SHIM_DIR_ENV, writeGitShim } from '../leak-guard/git-shim.js'
import { gitShimHarness, HOST_PATH, NO_VERIFY, type GitShimFixture } from './helpers/git-shim-fixture.js'
import { expectSpawned } from './helpers/spawn-result.js'

/** TP-4249, against real git, a scratch HOME and a local bare remote: shells git starts find the shim. */

const harness = gitShimHarness()
const { git, realGit } = harness

const IDENTITY = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't' }
const PUSH_X = `git push ${NO_VERIFY} origin HEAD:refs/heads/x`
const P_SH = `#!/bin/sh\n${PUSH_X}\n`
const has = (file: string): boolean => fs.existsSync(file)
const HAS_SHELLS = has('/bin/dash') && has('/bin/zsh') && has('/usr/bin/bash')
const HAS_SCRIPT = has('/usr/bin/script') && process.platform === 'linux'

type Repo = GitShimFixture

function commit(cwd: string, message: string): void {
  git(
    cwd,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.com',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    message,
  )
}

/** A submodule source holding p.sh, so foreach's `./p.sh` resolves in the submodule's checkout. */
function submoduleSource(root: string): string {
  const source = path.join(root, 'sub-src')
  fs.mkdirSync(source)
  git(source, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(source, 'p.sh'), P_SH)
  git(source, 'add', 'p.sh')
  commit(source, 'sub')
  return source
}

function addSubmodule(fx: GitShimFixture, source: string, name: string, at: string): void {
  git(fx.work, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '--name', name, source, at)
  commit(fx.work, `add ${at}`)
  git(path.join(fx.work, at), 'remote', 'set-url', 'origin', fx.remote)
}

/** Three commits, p.sh in the work tree and in two submodules whose origin is the bare remote, and alias pz allowlisted. */
function repo(): Repo {
  const fx = harness.fixture(['pz'])
  git(fx.work, 'config', 'alias.pz', '!sh ./p.sh')
  // A submodule child denies file:// by default, which would refuse every foreach push before the shim could.
  git(
    fx.work,
    'config',
    '--file',
    path.join(fx.env.HOME as string, '.gitconfig'),
    'protocol.file.allow',
    'always',
  )
  const source = submoduleSource(path.dirname(fx.work))
  addSubmodule(fx, source, 'plain', 'sub')
  addSubmodule(fx, source, 'a[$(sh ./p.sh)]', 'arith')
  commit(fx.work, 'three')
  fs.writeFileSync(path.join(fx.work, 'p.sh'), P_SH)
  const env = {
    ...fx.env,
    ...IDENTITY,
    GIT_COMMITTER_EMAIL: 't@example.com',
    GIT_EXEC_PATH: gitMirrorDirFor(fx.shimDir),
    SHELL: '/bin/sh',
  }
  return { ...fx, env }
}

/** The same repo with no shim and no mirror: what the row does when nothing intervenes. */
function unguarded(fx: Repo): Repo {
  const env: Record<string, string> & { PATH: string } = { ...fx.env, PATH: HOST_PATH }
  delete env.GIT_EXEC_PATH
  return { ...fx, env }
}

function run(fx: Repo, line: string): { status: number | null; output: string } {
  const result = expectSpawned(
    spawnSync('/bin/sh', ['-c', line], { cwd: fx.work, env: fx.env, encoding: 'utf8', timeout: 30_000 }),
    line,
  )
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

const remoteRefs = (fx: Repo): string =>
  git(path.dirname(fx.remote), '--git-dir', fx.remote, 'for-each-ref', '--format=%(refname)')

const DASH_ALIAS = `dash -c 'alias p="${PUSH_X}"\np'`

// Each row: the line, and whether git passes the refused child's status out (bisect run and a pager do not).
const REFUSED: [string, string, boolean][] = [
  ['rebase -x sh ./p.sh', `git rebase -x 'sh ./p.sh' HEAD~1`, true],
  ['rebase -x dash -c', `git rebase -x 'dash -c "${PUSH_X}"' HEAD~1`, true],
  ['rebase -x git-push', `git rebase -x 'git-push ${NO_VERIFY} origin HEAD:refs/heads/x' HEAD~1`, true],
  [
    'rebase -x zsh ARGV0=git-push',
    `git rebase -x 'zsh -fc "ARGV0=git-push git ${NO_VERIFY} origin HEAD:refs/heads/x"' HEAD~1`,
    true,
  ],
  [
    'rebase -x zsh exec -a git-push command git',
    `git rebase -x 'zsh -fc "exec -a git-push command git ${NO_VERIFY} origin HEAD:refs/heads/x"' HEAD~1`,
    true,
  ],
  ['foreach . ./p.sh (TP-4236)', `git submodule foreach '. ./p.sh'`, true],
  ['foreach sh ./p.sh (TP-4236)', `git submodule foreach 'sh ./p.sh'`, true],
  ['foreach dash alias (TP-4237)', `git submodule foreach '${DASH_ALIAS.replaceAll("'", `'\\''`)}'`, true],
  ['foreach .gitmodules arithmetic name', `git submodule foreach 'bash -c "let name"'`, true],
  ['bisect run sh ./p.sh', `git bisect start HEAD HEAD~2 && git bisect run sh ./p.sh`, false],
  ['allowlisted ! alias', `git pz`, true],
  ['pager under a pty', `GIT_PAGER='sh ./p.sh; cat' script -qec 'git -p log -1' /dev/null`, false],
  ['env -u GIT_EXEC_PATH', `env -u GIT_EXEC_PATH git rebase -x 'sh ./p.sh' HEAD~1`, true],
]

describe.skipIf(!HAS_SHELLS || !HAS_SCRIPT)('a push in a shell git starts reaches the shim (TP-4249)', () => {
  it.each(REFUSED)('%s lands a ref with no shim, so the row is a live bypass', (_name, line) => {
    const fx = unguarded(repo())
    run(fx, line)
    expect(remoteRefs(fx)).toContain('refs/heads/x')
  })

  it.each(REFUSED)('%s is refused at run time and creates no ref', (_name, line, passesStatus) => {
    const fx = repo()
    const result = run(fx, line)
    if (passesStatus) expect(result.status).not.toBe(0)
    expect(result.output).toMatch(/git-shim: push refused \((no-verify|unresolved)\)/)
    expect(remoteRefs(fx)).toBe('')
  })
})

const NODE_DIR = path.dirname(process.execPath)

describe('git through the mirror still works (TP-4249)', () => {
  it.each([
    ['rebase -x git status', `git rebase -x 'git status' HEAD~1`],
    ['rebase -x npm test', `git rebase -x 'npm test' HEAD~1`],
    ['foreach git status', `git submodule foreach 'git status'`],
    ['fetch', 'git fetch -q origin'],
    ['clone of a local repo', 'git clone -q . ../clone'],
    ['mergetool --tool-help', 'git mergetool --tool-help'],
  ])('%s exits 0', (_name, line) => {
    const fx = repo()
    fs.writeFileSync(path.join(fx.work, 'package.json'), '{"scripts":{"test":"git log -1"}}\n')
    const result = run({ ...fx, env: { ...fx.env, PATH: `${fx.env.PATH}:${NODE_DIR}` } }, line)
    expect(result.output).not.toContain('git-shim:')
    expect(result.status).toBe(0)
  })

  it('a rebase -x push without the skip flag reaches the pre-push hook', () => {
    const fx = repo()
    const result = run(fx, `git rebase -x 'git push -q origin HEAD:refs/heads/ok' HEAD~1`)
    expect(result.status).toBe(0)
    expect(fs.existsSync(fx.marker)).toBe(true)
    expect(remoteRefs(fx)).toContain('refs/heads/ok')
  })

  it('git help -a lists the same commands with and without the mirror', () => {
    const fx = repo()
    const listed = (env: Record<string, string>): string =>
      spawnSync(realGit, ['help', '-a'], { cwd: fx.work, env, encoding: 'utf8' }).stdout
    const real = { ...fx.env }
    delete real.GIT_EXEC_PATH
    expect(listed(fx.env)).toBe(listed(real))
  })

  it('git --exec-path prints the mirror, even when the caller unset it', () => {
    const fx = repo()
    expect(run(fx, 'env -u GIT_EXEC_PATH git --exec-path').output.trim()).toBe(gitMirrorDirFor(fx.shimDir))
  })
})

describe('the shim refuses an --exec-path=<dir> that is not its mirror (TP-4249)', () => {
  it('refuses a foreign dir and creates no ref', () => {
    const fx = repo()
    const core = git(fx.work, '--exec-path').trim()
    const result = run(fx, `git --exec-path=${core} rebase -x 'sh ./p.sh' HEAD~1`)
    expect(result.status).toBe(2)
    expect(result.output).toContain('git-shim: refused (exec-path)')
    expect(remoteRefs(fx)).toBe('')
  })

  it('refuses one an alias expands to', () => {
    const fx = repo()
    git(fx.work, 'config', 'alias.ep', '--exec-path=/elsewhere status')
    expect(run(fx, 'git ep').output).toContain('git-shim: refused (exec-path)')
  })

  it('passes the mirror itself', () => {
    const fx = repo()
    expect(run(fx, `git --exec-path=${gitMirrorDirFor(fx.shimDir)} status --short`).status).toBe(0)
  })
})

describe('the mirror the shim writer builds (TP-4249)', () => {
  const builtins = (): string[] =>
    git(harness.scratch, '--list-cmds=builtins')
      .split('\n')
      .filter(name => name !== '')

  it('links git and every dashed builtin to the shim, and the rest to the real core', () => {
    const fx = harness.fixture()
    const mirror = gitMirrorDirFor(fx.shimDir)
    const shim = fs.realpathSync(path.join(fx.shimDir, 'git'))
    const missing = ['git', ...builtins().map(name => `git-${name}`)].filter(
      name => fs.realpathSync(path.join(mirror, name)) !== shim,
    )
    expect(missing).toEqual([])
    const core = git(fx.work, '--exec-path').trim()
    expect(fs.realpathSync(path.join(mirror, 'git-sh-setup'))).toBe(
      fs.realpathSync(path.join(core, 'git-sh-setup')),
    )
  })

  it('reads the real core even when the writer inherits GIT_EXEC_PATH', () => {
    const fx = harness.fixture()
    const mirror = gitMirrorDirFor(fx.shimDir)
    const core = git(fx.work, '--exec-path').trim()
    const saved = process.env.GIT_EXEC_PATH
    process.env.GIT_EXEC_PATH = mirror
    try {
      expect(writeGitShim(fx.shimDir, fx.guard, HOST_PATH)).toBe(true)
    } finally {
      if (saved === undefined) delete process.env.GIT_EXEC_PATH
      else process.env.GIT_EXEC_PATH = saved
    }
    expect(fs.readFileSync(path.join(fx.shimDir, 'git'), 'utf8')).toContain(`exec_path='${core}'`)
    expect(fs.realpathSync(path.join(mirror, 'git-sh-setup'))).toBe(
      fs.realpathSync(path.join(core, 'git-sh-setup')),
    )
  })

  it('adds a shim link for a builtin the core has no dashed entry for', () => {
    const entries = mirrorEntries(['git', 'git-sh-setup'], ['push'], '/core', '/bin/shim')
    expect(Object.fromEntries(entries)).toEqual({
      git: '/bin/shim',
      'git-push': '/bin/shim',
      'git-sh-setup': '/core/git-sh-setup',
    })
  })
})

describe('the launcher points agents at the mirror (TP-4249)', () => {
  const plan = (env: Record<string, string>): LaunchPlan => ({
    agentId: 'agt-mirror',
    bin: 'claude',
    args: [],
    cwd: '/work',
    env,
    title: 'agt-mirror',
    surface: 'headless',
  })
  const base = { PATH: '/usr/bin:/bin' }

  it('sets GIT_EXEC_PATH to the mirror over a profile value', () => {
    const fx = harness.fixture()
    const env = { [GIT_SHIM_DIR_ENV]: fx.shimDir, GIT_EXEC_PATH: '/elsewhere' }

    expect(withShims(plan(env), base).env.GIT_EXEC_PATH).toBe(gitMirrorDirFor(fx.shimDir))
  })

  it('leaves it alone when no mirror was built', () => {
    const env = { [GIT_SHIM_DIR_ENV]: path.join(harness.scratch, 'no-shim') }

    expect('GIT_EXEC_PATH' in withShims(plan(env), base).env).toBe(false)
  })
})
