import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  defaultScanInputs,
  gitHooksEnv,
  hookScripts,
  MISSING_TERMS_REFUSES,
  termsFileFor,
  writeGitHooks,
} from '../leak-guard/hooks-dir.js'

const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-prepush-')))

afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }))

const HELP = `usage: titan-egress-scan <command>
  pre-push <remote>     scan the commits a push sends (reads git's pre-push stdin)
files git calls binary are scanned as text; a commit or tree over 128 MiB of patch text exits 2
exit: 0 clean, 1 findings, 2 usage or configuration error`

// Every fixture is synthetic: a made-up home and a made-up marker term.
const HOME = '/Users/zq7-probe-home'
const LEAK = 'zq7leakterm'

/**
 * Mirrors titan-egress-scan 0.2.0, which scans binary files as text: a CI value skips the term list, a missing list exits 2 only under
 * TITAN_EGRESS_REQUIRE_TERMS=1, and a pushed commit holding the marker is a finding (exit 1). It
 * logs to a baked path, because the hook hands it no variable of the agent's.
 */
const egressStub = (log = '/dev/null'): string => `[ "$1" = --help ] && { cat <<'EOF'
${HELP}
EOF
exit 0; }
[ "$1" = pre-push ] || exit 2
refs=$(cat)
printf 'args=%s CI=%s REQUIRE=%s\\n%s\\n' "$*" "\${CI-unset}" "\${TITAN_EGRESS_REQUIRE_TERMS-unset}" "$refs" > '${log}'
env > '${log}.env'
terms=\${TITAN_EGRESS_TERMS:-\${XDG_CONFIG_HOME:-$HOME/.config}/titan-egress/private-terms}
case \${CI:-} in
'' | false | 0)
  if [ ! -f "$terms" ]; then
    [ "\${TITAN_EGRESS_REQUIRE_TERMS:-}" = 1 ] && { echo 'titan-egress-scan: private term list not found and TITAN_EGRESS_REQUIRE_TERMS=1' >&2; exit 2; }
    echo 'titan-egress-scan: private term list not found; generic rules only' >&2
  fi ;;
esac
for sha in $(printf '%s\\n' "$refs" | awk '{ print $2 }'); do
  grep -q ${LEAK} "$terms" 2>/dev/null && git show --text "$sha" | grep -q ${LEAK} && { echo 'commit 1 notes.md:1 private-term'; exit 1; }
done
exit 0`

interface Tools {
  node?: boolean
  git?: boolean
  egress?: string
  /** Any other command name, as a sh script body. */
  scripts?: Record<string, string>
}

const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()

/** A PATH dir holding only the named tools, so a test controls what the hook can find. */
function binWith(tools: Tools): string {
  const dir = fs.mkdtempSync(path.join(SCRATCH, 'bin-'))
  if (tools.node) fs.symlinkSync(process.execPath, path.join(dir, 'node'))
  if (tools.git) fs.symlinkSync(REAL_GIT, path.join(dir, 'git'))
  const scripts = {
    ...tools.scripts,
    ...(tools.egress === undefined ? {} : { 'titan-egress-scan': tools.egress }),
  }
  for (const [name, body] of Object.entries(scripts))
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return dir
}

const SYSTEM_PATH = '/usr/bin:/bin'
const pathWithStub = (script?: string): string =>
  `${binWith({ node: true, git: true, ...(script === undefined ? {} : { egress: script }) })}:${SYSTEM_PATH}`

describe('hookScripts', () => {
  afterEach(() => vi.unstubAllEnvs())

  // Regression: a baked Cellar node or worktree dist path refused every push once it went away.
  it('bakes in no node or cli path, finding both on PATH when the hook runs', () => {
    const shim = hookScripts().get('pre-push') ?? ''

    expect(shim).not.toContain(process.execPath)
    expect(shim).not.toContain('cli.js')
    expect(shim).toContain('titan-egress-scan pre-push "$1"')
  })

  it('bakes in the passwd home and only the absolute entries of the broker PATH', () => {
    vi.stubEnv('HOME', HOME)
    vi.stubEnv('PATH', `/opt/zq7/bin:relative/bin:.:${SYSTEM_PATH}`)

    const inputs = defaultScanInputs()

    expect(inputs.home).toBe(os.userInfo().homedir)
    expect(inputs.path).toBe(`/opt/zq7/bin:${SYSTEM_PATH}`)
  })

  it('writes executable shims for pre-push and the gating commit hooks only', () => {
    const dir = path.join(SCRATCH, 'hooks-perm')
    writeGitHooks(dir)

    for (const name of ['pre-push', 'pre-commit', 'commit-msg'])
      expect(fs.statSync(path.join(dir, name)).mode & 0o777).toBe(0o755)
    for (const hot of ['reference-transaction', 'post-index-change', 'post-commit', 'pre-receive', 'update'])
      expect(fs.existsSync(path.join(dir, hot))).toBe(false)
  })
})

interface Fixture {
  work: string
  remote: string
  chatHome: string
  ownerHome: string
  marker: string
  stubLog: string
  termsFile: string
  agentEnv: NodeJS.ProcessEnv
}

const baseEnv = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Probe',
  GIT_AUTHOR_EMAIL: 'probe@example.com',
  GIT_COMMITTER_NAME: 'Probe',
  GIT_COMMITTER_EMAIL: 'probe@example.com',
})

const git = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()

function commitFile(f: Fixture, branch: string, file: string, text: string): void {
  git(f.work, baseEnv(), 'checkout', '-q', '-B', branch, 'main')
  fs.writeFileSync(path.join(f.work, file), `${text}\n`)
  git(f.work, baseEnv(), 'add', file)
  git(f.work, baseEnv(), 'commit', '-q', '-m', `add ${file}`)
}

function initRepos(root: string): { work: string; remote: string } {
  const [work, remote] = ['work', 'remote.git'].map(d => path.join(root, d)) as [string, string]
  git(root, baseEnv(), 'init', '-q', '--bare', '-b', 'main', remote)
  git(root, baseEnv(), 'init', '-q', '-b', 'main', work)
  git(work, baseEnv(), 'remote', 'add', 'origin', remote)
  fs.writeFileSync(path.join(work, 'README.md'), 'hello\n')
  git(work, baseEnv(), 'add', 'README.md')
  git(work, baseEnv(), 'commit', '-q', '-m', 'init')
  git(work, baseEnv(), 'push', '-q', 'origin', 'main')
  return { work, remote }
}

interface FixtureOpts {
  terms?: boolean
  missingTermsRefuses?: boolean
  /** The broker PATH baked into the hook; the agent's own PATH never reaches the scan. */
  scanPath?: string
  /** The interpreter the guard hooks are written for; the default is the host's choice. */
  shell?: string
}

/** A work repo whose origin is a local bare repo, with the guard hooks and a repo-local pre-push hook. */
function fixture(opts: FixtureOpts = {}): Fixture {
  const root = fs.mkdtempSync(path.join(SCRATCH, 'repo-'))
  const { work, remote } = initRepos(root)
  const chatHome = path.join(root, 'chat')
  const marker = path.join(root, 'repo-hook-ran')
  const ownerHome = path.join(root, 'owner-home')
  const termsFile = termsFileFor(ownerHome)
  if (opts.terms !== false) {
    fs.mkdirSync(path.dirname(termsFile), { recursive: true })
    fs.writeFileSync(termsFile, `${LEAK}\n`, { mode: 0o600 })
  }
  fs.writeFileSync(
    path.join(work, '.git', 'hooks', 'pre-push'),
    `#!/bin/sh\nread -r ref sha rest && echo "$1 $ref" >> '${marker}'\n`,
    { mode: 0o755 },
  )
  const hooksDir = path.join(chatHome, 'git-hooks')
  const stubLog = path.join(root, 'stub.log')
  writeGitHooks(
    hooksDir,
    {
      missingTermsRefuses: opts.missingTermsRefuses ?? MISSING_TERMS_REFUSES,
      home: ownerHome,
      path: opts.scanPath ?? pathWithStub(egressStub(stubLog)),
    },
    opts.shell,
  )
  const agentEnv = { ...baseEnv(), ...gitHooksEnv(hooksDir) }
  return { work, remote, chatHome, ownerHome, marker, stubLog, termsFile, agentEnv }
}

function push(
  f: Fixture,
  branch: string,
  gitArgs: string[] = [],
): { code: number; stdout: string; stderr: string } {
  const run = spawnSync('git', [...gitArgs, 'push', '-q', 'origin', branch], {
    cwd: f.work,
    env: f.agentEnv,
    encoding: 'utf8',
  })
  return { code: run.status ?? -1, stdout: run.stdout, stderr: run.stderr }
}

const remoteHas = (f: Fixture, branch: string): boolean =>
  spawnSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { cwd: f.remote, env: baseEnv() })
    .status === 0

const remoteAt = (f: Fixture, branch: string): string =>
  spawnSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], {
    cwd: f.remote,
    env: baseEnv(),
    encoding: 'utf8',
  }).stdout.trim()

const repoHookRuns = (f: Fixture): string[] =>
  fs.existsSync(f.marker) ? fs.readFileSync(f.marker, 'utf8').trim().split('\n') : []

const stubSaw = (f: Fixture): string[] => fs.readFileSync(f.stubLog, 'utf8').trim().split('\n')

/** Lands a file on the remote's default branch outside the agent env, the way a merged PR does. */
function landOnMain(f: Fixture, file: string, text: string): void {
  commitFile(f, 'main', file, text)
  git(f.work, baseEnv(), 'push', '-q', 'origin', 'main')
}

describe('git push under the agent env', () => {
  it('points core.hooksPath at the guard dir', () => {
    const f = fixture()

    expect(git(f.work, f.agentEnv, 'config', 'core.hooksPath')).toBe(path.join(f.chatHome, 'git-hooks'))
    expect(git(f.work, baseEnv(), 'config', '--default', 'none', 'core.hooksPath')).toBe('none')
  })

  it("lets a clean push through, scanning a new branch from the remote's default branch, and runs the repo hook", () => {
    const f = fixture()
    commitFile(f, 'clean', 'notes.md', 'nothing private')
    const [sha, main] = ['clean', 'main'].map(rev => git(f.work, baseEnv(), 'rev-parse', rev))

    const run = push(f, 'clean')

    expect(run).toMatchObject({ code: 0, stderr: '' })
    expect(remoteHas(f, 'clean')).toBe(true)
    expect(repoHookRuns(f)).toEqual(['origin refs/heads/clean'])
    expect(stubSaw(f)).toEqual([
      'args=pre-push origin CI=unset REQUIRE=1',
      `refs/heads/clean ${sha} refs/heads/clean ${main}`,
    ])
  })

  it('refuses a push egress-scan reports findings for, and still runs the repo hook', () => {
    const f = fixture()
    commitFile(f, 'leaky', 'notes.md', `the ${LEAK} seat`)

    const run = push(f, 'leaky')

    expect(run.code).not.toBe(0)
    expect(run.stdout + run.stderr).toContain('notes.md:1 private-term')
    expect(remoteHas(f, 'leaky')).toBe(false)
    expect(repoHookRuns(f)).toEqual(['origin refs/heads/leaky'])
  })

  it('refuses the push when the repo hook fails even though the scan is clean', () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.work, '.git', 'hooks', 'pre-push'), '#!/bin/sh\nexit 3\n', { mode: 0o755 })
    commitFile(f, 'clean', 'notes.md', 'fine')

    expect(push(f, 'clean').code).not.toBe(0)
    expect(remoteHas(f, 'clean')).toBe(false)
  })

  it('chains other hooks, so a repo pre-commit hook still refuses a commit', () => {
    const f = fixture()
    fs.writeFileSync(path.join(f.work, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    fs.writeFileSync(path.join(f.work, 'x.md'), 'x\n')
    git(f.work, f.agentEnv, 'add', 'x.md')

    const run = spawnSync('git', ['commit', '-q', '-m', 'x'], { cwd: f.work, env: f.agentEnv })

    expect(run.status).not.toBe(0)
  })

  it('does not loop when the repo itself points core.hooksPath at the guard dir', () => {
    const f = fixture()
    git(f.work, baseEnv(), 'config', 'core.hooksPath', path.join(f.chatHome, 'git-hooks'))
    commitFile(f, 'clean', 'notes.md', 'fine')

    expect(push(f, 'clean')).toMatchObject({ code: 0, stderr: '' })
  })
})

describe('git push with no private term list', () => {
  const pointer = (f: Fixture): string =>
    `leak-scan: push refused: no private term list at ${f.termsFile}. Create it, one term per line, chmod 600; see docs/leak-guard.md.`

  it('refuses the push and names the file to create', () => {
    const f = fixture({ terms: false })
    commitFile(f, 'clean', 'notes.md', 'fine')

    const run = push(f, 'clean')

    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain(pointer(f))
    expect(remoteHas(f, 'clean')).toBe(false)
    expect(repoHookRuns(f)).toEqual(['origin refs/heads/clean'])
  })

  // egress-scan never reads the term list when CI is set, so an agent with CI in its env would skip it.
  it.each(['true', '1'])('still refuses when the agent env has CI=%s', ci => {
    const f = fixture({ terms: false })
    f.agentEnv.CI = ci
    commitFile(f, 'clean', 'notes.md', 'fine')

    const run = push(f, 'clean')

    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain(pointer(f))
    expect(stubSaw(f)[0]).toBe('args=pre-push origin CI=unset REQUIRE=1')
  })

  // CC-302: an inherited TITAN_EGRESS_TERMS must not swap the scanner's term list.
  it.each(['/dev/null', 'empty-file'])('ignores an inherited TITAN_EGRESS_TERMS of %s', value => {
    const f = fixture()
    const empty = path.join(path.dirname(f.termsFile), 'empty')
    fs.writeFileSync(empty, '')
    f.agentEnv.TITAN_EGRESS_TERMS = value === 'empty-file' ? empty : value
    commitFile(f, 'leaky', 'notes.md', `the ${LEAK} seat`)

    const run = push(f, 'leaky')

    expect(run.code).not.toBe(0)
    expect(run.stdout + run.stderr).toContain('notes.md:1 private-term')
    expect(remoteHas(f, 'leaky')).toBe(false)
  })

  it('still refuses a missing default list when TITAN_EGRESS_TERMS names an existing file', () => {
    const f = fixture({ terms: false })
    const other = path.join(path.dirname(f.chatHome), 'other-terms')
    fs.writeFileSync(other, `${LEAK}\n`)
    f.agentEnv.TITAN_EGRESS_TERMS = other
    commitFile(f, 'clean', 'notes.md', 'fine')

    const run = push(f, 'clean')

    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain('no private term list')
  })

  it('warns and lets the push through when the missing-terms switch is flipped', () => {
    const f = fixture({ terms: false, missingTermsRefuses: false })
    commitFile(f, 'clean', 'notes.md', 'fine')

    const run = push(f, 'clean')

    expect(run.code).toBe(0)
    expect(run.stderr).toContain(
      `leak-scan: WARNING: no private term list at ${f.termsFile}, so this push was scanned with generic rules only.`,
    )
    expect(remoteHas(f, 'clean')).toBe(true)
  })
})

describe('git push when the guard cannot run', () => {
  const pathWithout = (tool: 'node' | 'titan-egress-scan'): string =>
    tool === 'node' ? [binWith({ git: true, egress: egressStub() }), SYSTEM_PATH].join(':') : pathWithStub()

  // Fail open: a guard that cannot start must not refuse every push; S3's tick backstop still reports leaks.
  it.each([
    ['titan-egress-scan', 'Run npm i -g @titan-design/egress-scan; see docs/leak-guard.md.'],
    ['node', 'Put node on it and restart the broker; see docs/leak-guard.md.'],
  ] as const)(
    "lets the push through with one loud line when %s is not on the broker's PATH, and runs the repo hook",
    (tool, hint) => {
      const onSystemPath = SYSTEM_PATH.split(':').some(dir => fs.existsSync(path.join(dir, tool)))
      if (onSystemPath) return
      const f = fixture({ scanPath: pathWithout(tool) })
      commitFile(f, 'leaky', 'notes.md', `the ${LEAK} seat`)

      const run = push(f, 'leaky')

      expect(run.code).toBe(0)
      expect(run.stderr.trim().split('\n')).toEqual([
        `leak-scan: guard NOT run, this push was not scanned: no ${tool} on the broker's PATH. ${hint}`,
      ])
      expect(repoHookRuns(f)).toEqual(['origin refs/heads/leaky'])
    },
  )

  // An egress-scan too old for pre-push must not refuse clean pushes; the probe routes it to fail-open.
  const STALE_SCANNER = `[ "$1" = --help ] && { echo 'usage: titan-egress-scan <command>'; echo '  range <base> <head>'; exit 0; }
echo "titan-egress-scan: unknown command" >&2; exit 2`

  it('lets a clean push through with one loud line when the installed scanner has no pre-push', () => {
    const f = fixture({ scanPath: pathWithStub(STALE_SCANNER) })
    commitFile(f, 'clean', 'notes.md', 'fine')

    const run = push(f, 'clean')

    expect(run.code).toBe(0)
    expect(run.stderr.trim().split('\n')).toEqual([
      "leak-scan: guard NOT run, this push was not scanned: the titan-egress-scan on the broker's PATH has no pre-push command. Run npm i -g @titan-design/egress-scan; see docs/leak-guard.md.",
    ])
    expect(remoteHas(f, 'clean')).toBe(true)
    expect(repoHookRuns(f)).toEqual(['origin refs/heads/clean'])
  })

  it.each([
    ['its help check crashes', 'echo boom >&2; exit 1'],
    [
      'it passes the help check and then crashes',
      `[ "$1" = --help ] && { echo '  pre-push <remote>'; exit 0; }; exit 2`,
    ],
  ])('refuses a clean push when the installed scanner %s', (_, script) => {
    const f = fixture({ scanPath: pathWithStub(script) })
    commitFile(f, 'clean', 'notes.md', 'fine')

    const run = push(f, 'clean')

    expect(run.code).not.toBe(0)
    expect(run.stderr).not.toContain('guard NOT run')
    expect(remoteHas(f, 'clean')).toBe(false)
  })
})

describe('a scanner that skips binary files', () => {
  // CC-343: a 0.1.x scanner has pre-push but skips a file git calls binary; its help lacks the text-scan line.
  const NO_TEXT_SCAN = `[ "$1" = --help ] && { echo '  pre-push <remote>'; exit 0; }; exit 0`

  it('refuses a clean push with the install hint instead of the fail-open warning', () => {
    const f = fixture({ scanPath: pathWithStub(NO_TEXT_SCAN) })
    commitFile(f, 'clean', 'notes.md', 'fine')

    const run = push(f, 'clean')

    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain(
      'skips binary files, so the push is refused. Run npm i -g @titan-design/egress-scan',
    )
    expect(run.stderr).not.toContain('guard NOT run')
    expect(remoteHas(f, 'clean')).toBe(false)
  })
})

describe('scanner inputs the agent environment cannot change', () => {
  // CC-310: egress-scan derives the term list from XDG_CONFIG_HOME or HOME, which the agent controls.
  it('scans with the owner term list when the agent points XDG_CONFIG_HOME and HOME at an empty one', () => {
    const f = fixture()
    const hostile = path.join(path.dirname(f.chatHome), 'hostile')
    fs.mkdirSync(path.join(hostile, 'titan-egress'), { recursive: true })
    fs.writeFileSync(path.join(hostile, 'titan-egress', 'private-terms'), '')
    Object.assign(f.agentEnv, { XDG_CONFIG_HOME: hostile, HOME: hostile })
    commitFile(f, 'leaky', 'notes.md', `the ${LEAK} seat`)

    const run = push(f, 'leaky')

    expect(run.code).not.toBe(0)
    expect(run.stdout + run.stderr).toContain('notes.md:1 private-term')
    expect(remoteHas(f, 'leaky')).toBe(false)
  })

  // CC-312: the scanner was found on the agent's PATH, so a shadow or a bare PATH skipped it.
  it.each([
    [
      'a shadow scanner that always passes first',
      () => `${binWith({ egress: 'exit 0' })}:${process.env.PATH}`,
    ],
    ['no scanner at all', () => `${binWith({ git: true })}:${SYSTEM_PATH}`],
  ])('still scans a push when the agent PATH has %s', (_, agentPath) => {
    const f = fixture()
    f.agentEnv.PATH = agentPath()
    commitFile(f, 'leaky', 'notes.md', `the ${LEAK} seat`)

    const run = push(f, 'leaky')

    expect(run.code).not.toBe(0)
    expect(run.stdout + run.stderr).toContain('notes.md:1 private-term')
    expect(remoteHas(f, 'leaky')).toBe(false)
  })

  // The fixture's repo hook fails on empty stdin, which would refuse these pushes for the wrong reason.
  const dropRepoHook = (f: Fixture): void => fs.rmSync(path.join(f.work, '.git', 'hooks', 'pre-push'))

  // The scan's ref lines are read outside the scan step; a shadow cat on the agent PATH emptied them.
  it('reads the ref lines with the broker PATH, so a shadow cat cannot hide the push from the scan', () => {
    const f = fixture()
    dropRepoHook(f)
    f.agentEnv.PATH = `${binWith({ scripts: { cat: 'exit 0' } })}:${process.env.PATH}`
    commitFile(f, 'leaky', 'notes.md', `the ${LEAK} seat`)

    const run = push(f, 'leaky')

    expect(run.code).not.toBe(0)
    expect(run.stdout + run.stderr).toContain('notes.md:1 private-term')
    expect(remoteHas(f, 'leaky')).toBe(false)
  })

  // CC-310 review: sh on macOS is bash, which imports functions from the environment.
  it.each([
    ['titan-egress-scan', '() { echo pre-push; }'],
    ['cat', '() { :; }'],
  ])('still scans a push when the agent env holds a shell function named %s', (name, body) => {
    const f = fixture()
    dropRepoHook(f)
    f.agentEnv[`BASH_FUNC_${name}%%`] = body
    commitFile(f, 'leaky', 'notes.md', `the ${LEAK} seat`)

    const run = push(f, 'leaky')

    expect(run.code).not.toBe(0)
    expect(run.stdout + run.stderr).toContain('notes.md:1 private-term')
    expect(remoteHas(f, 'leaky')).toBe(false)
  })

  // Run directly: a push to a local path starts receive-pack through sh, which noexec also stops.
  it('runs when the agent env holds SHELLOPTS=noexec, which makes bash read a script and do nothing', () => {
    const f = fixture()
    commitFile(f, 'leaky', 'notes.md', `the ${LEAK} seat`)
    const sha = git(f.work, baseEnv(), 'rev-parse', 'leaky')

    const run = spawnSync(path.join(f.chatHome, 'git-hooks', 'pre-push'), ['origin', f.remote], {
      cwd: f.work,
      env: { ...f.agentEnv, SHELLOPTS: 'noexec' },
      input: `refs/heads/leaky ${sha} refs/heads/leaky ${'0'.repeat(40)}\n`,
      encoding: 'utf8',
    })

    expect(run.status).toBe(1)
    expect(run.stdout).toContain('notes.md:1 private-term')
  })

  it('hands the scanner PATH and its two settings and no variable of the agent', () => {
    const f = fixture()
    const scratch = path.dirname(f.chatHome)
    Object.assign(f.agentEnv, {
      HOME: scratch,
      XDG_CONFIG_HOME: scratch,
      NODE_PATH: scratch,
      NODE_OPTIONS: '--no-warnings',
      LD_LIBRARY_PATH: scratch,
      DYLD_LIBRARY_PATH: scratch,
      CI: 'true',
      ZQ7_CANARY: '1',
    })
    commitFile(f, 'clean', 'notes.md', 'fine')
    const setByTheShell = new Set(['PWD', 'OLDPWD', 'SHLVL', '_'])

    const run = push(f, 'clean')

    const names = fs
      .readFileSync(`${f.stubLog}.env`, 'utf8')
      .trim()
      .split('\n')
      .map(line => line.slice(0, line.indexOf('=')))
      .filter(name => !setByTheShell.has(name))
    expect(run.code).toBe(0)
    expect(names.sort()).toEqual(['PATH', 'TITAN_EGRESS_REQUIRE_TERMS', 'TITAN_EGRESS_TERMS'])
  })
})

const scannerBin = fileURLToPath(
  new URL('../../node_modules/@titan-design/egress-scan/dist/bin.js', import.meta.url),
)

/** A broker PATH whose titan-egress-scan is the installed package, not the stub. */
const realScanPath = (): string => {
  const dir = binWith({ node: true, git: true })
  fs.symlinkSync(scannerBin, path.join(dir, 'titan-egress-scan'))
  return `${dir}:${SYSTEM_PATH}`
}
// Built by join so this file's own diff carries no home path.
const homePathLine = `see ${['', 'Users', 'zq7probe', 'notes'].join('/')}`
const ALLOW = 'notes.md home-path synthetic fixture, ZQ-1\n'

describe('the real titan-egress-scan under a hostile agent env', () => {
  // CC-312: NODE_OPTIONS=--require runs agent code inside the scanner before it scans.
  it('clears NODE_OPTIONS, so a preloaded exit(0) cannot pass a leaky push', () => {
    const f = fixture({ scanPath: realScanPath() })
    const preload = path.join(path.dirname(f.chatHome), 'pass.cjs')
    fs.writeFileSync(preload, 'process.exit(0)\n')
    const preloaded = spawnSync(process.execPath, [scannerBin, 'tree'], {
      cwd: f.work,
      env: { ...f.agentEnv, NODE_OPTIONS: `--require ${preload}` },
    })
    f.agentEnv.NODE_OPTIONS = `--require ${preload}`
    commitFile(f, 'leaky', 'notes.md', `the ${LEAK} seat`)

    const run = push(f, 'leaky')

    expect(preloaded.status).toBe(0)
    expect(run.code).not.toBe(0)
    expect(run.stdout).toContain('private-term')
    expect(remoteHas(f, 'leaky')).toBe(false)
  })

  // The scanner's git honours attributes and replace refs, and `-diff` makes a file binary, which it skips.
  it.each([
    [
      'git attributes under the agent HOME',
      (f: Fixture) => {
        const home = path.join(path.dirname(f.chatHome), 'hostile-home')
        fs.mkdirSync(path.join(home, '.config', 'git'), { recursive: true })
        fs.writeFileSync(path.join(home, '.config', 'git', 'attributes'), '* -diff\n')
        Object.assign(f.agentEnv, { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') })
      },
    ],
    [
      'attributes in the repo info dir',
      (f: Fixture) => fs.writeFileSync(path.join(f.work, '.git', 'info', 'attributes'), '* -diff\n'),
    ],
    [
      'a replace ref over the pushed commit',
      (f: Fixture) => git(f.work, baseEnv(), 'replace', git(f.work, baseEnv(), 'rev-parse', 'leaky'), 'main'),
    ],
  ])('scans the pushed objects as they are, despite %s', (_, blind) => {
    const f = fixture({ scanPath: realScanPath() })
    commitFile(f, 'leaky', 'notes.md', `the ${LEAK} seat`)
    blind(f)

    const run = push(f, 'leaky')

    expect(run.code).not.toBe(0)
    expect(run.stdout).toContain('private-term')
    expect(remoteHas(f, 'leaky')).toBe(false)
  })

  // CC-343: one NUL byte made git call the file binary, and 0.1.x skipped it.
  it('refuses a push whose only leak sits in a file with one NUL byte', () => {
    const f = fixture({ scanPath: realScanPath() })
    commitFile(f, 'leaky', 'blob.dat', `the ${LEAK} seat\0tail`)

    const run = push(f, 'leaky')

    expect(run.code).not.toBe(0)
    expect(run.stdout).toContain('blob.dat:1 private-term')
    expect(remoteHas(f, 'leaky')).toBe(false)
  })
})

describe('the commits a push is scanned for', () => {
  // CC-310 review: the scanner skips commits a local remote-tracking ref holds, and an agent can write one.
  it('scans a new branch whose commits a forged remote-tracking ref already holds', () => {
    const f = fixture({ scanPath: realScanPath() })
    commitFile(f, 'leaky', 'notes.md', `the ${LEAK} seat`)
    git(f.work, baseEnv(), 'update-ref', 'refs/remotes/origin/decoy', 'leaky')

    const run = push(f, 'leaky')

    expect(run.code).not.toBe(0)
    expect(run.stdout).toContain('notes.md:1 private-term')
    expect(remoteHas(f, 'leaky')).toBe(false)
  })

  it('refuses a new branch when the remote names no default branch to scan it against', () => {
    const f = fixture()
    git(f.remote, baseEnv(), 'symbolic-ref', 'HEAD', 'refs/heads/absent')
    commitFile(f, 'clean', 'notes.md', 'fine')

    const run = push(f, 'clean')

    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain('origin names no default branch to scan refs/heads/clean against')
    expect(remoteHas(f, 'clean')).toBe(false)
  })

  it('scans a forced push over a remote commit this clone lacks from the default branch', () => {
    const f = fixture()
    commitFile(f, 'shared', 'notes.md', 'fine')
    git(f.work, baseEnv(), 'push', '-q', 'origin', 'shared')
    const other = path.join(path.dirname(f.work), 'other')
    git(path.dirname(f.work), baseEnv(), 'clone', '-q', '-b', 'shared', f.remote, other)
    git(other, baseEnv(), 'commit', '-q', '--allow-empty', '-m', 'ahead')
    git(other, baseEnv(), 'push', '-q', 'origin', 'shared')
    commitFile(f, 'shared', 'notes.md', 'rewritten')
    const [sha, main] = ['shared', 'main'].map(rev => git(f.work, baseEnv(), 'rev-parse', rev))

    const run = push(f, '+shared')

    expect(run.code).toBe(0)
    expect(stubSaw(f)[1]).toBe(`refs/heads/shared ${sha} refs/heads/shared ${main}`)
  })

  it('scans every ref of a push that sends several', () => {
    const f = fixture()
    commitFile(f, 'leaky', 'notes.md', `the ${LEAK} seat`)
    commitFile(f, 'clean', 'notes.md', 'fine')

    const run = spawnSync('git', ['push', '-q', 'origin', 'clean', 'leaky'], { cwd: f.work, env: f.agentEnv })

    expect(run.status).not.toBe(0)
    expect(stubSaw(f)).toHaveLength(3)
    expect(remoteHas(f, 'clean')).toBe(false)
  })

  it('still scans a later push to a branch the remote has, from the sha git reports for it', () => {
    const f = fixture()
    git(f.remote, baseEnv(), 'symbolic-ref', 'HEAD', 'refs/heads/absent')
    const before = git(f.work, baseEnv(), 'rev-parse', 'main')
    commitFile(f, 'main', 'notes.md', 'fine')

    const run = push(f, 'main')

    expect(run.code).toBe(0)
    expect(stubSaw(f)[1]).toBe(
      `refs/heads/main ${git(f.work, baseEnv(), 'rev-parse', 'main')} refs/heads/main ${before}`,
    )
  })
})

describe('pushed objects that are not commits', () => {
  const remoteTag = (f: Fixture, tag: string): string =>
    spawnSync('git', ['rev-parse', '--verify', '-q', `refs/tags/${tag}`], {
      cwd: f.remote,
      env: baseEnv(),
      encoding: 'utf8',
    }).stdout.trim()

  const blobSha = (f: Fixture): string => {
    fs.writeFileSync(path.join(f.work, 'loose.txt'), `the ${LEAK} seat\n`)
    return git(f.work, baseEnv(), 'hash-object', '-w', 'loose.txt')
  }

  it('refuses a blob sha pushed to a tag ref', () => {
    const f = fixture()

    const run = push(f, `${blobSha(f)}:refs/tags/x`)

    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain('refs/tags/x')
    expect(remoteTag(f, 'x')).toBe('')
  })

  it('refuses a tree sha pushed to a tag ref', () => {
    const f = fixture()

    const run = push(f, `${git(f.work, baseEnv(), 'rev-parse', 'main^{tree}')}:refs/tags/x`)

    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain('refs/tags/x')
    expect(remoteTag(f, 'x')).toBe('')
  })

  it('refuses an annotated tag, whose message the scan cannot read', () => {
    const f = fixture()
    git(f.work, baseEnv(), 'tag', '-a', '-m', `the ${LEAK} seat`, 'v1')

    const run = push(f, 'refs/tags/v1')

    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain('refs/tags/v1')
    expect(remoteTag(f, 'v1')).toBe('')
  })

  it('refuses moving an existing tag to a blob', () => {
    const f = fixture()
    git(f.work, baseEnv(), 'tag', 'x', 'main')
    expect(push(f, 'refs/tags/x').code).toBe(0)
    const before = remoteTag(f, 'x')

    const run = push(f, `+${blobSha(f)}:refs/tags/x`)

    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain('refs/tags/x')
    expect(remoteTag(f, 'x')).toBe(before)
  })

  it('lets a lightweight tag on a clean commit and a ref deletion through', () => {
    const f = fixture()
    commitFile(f, 'clean', 'notes.md', 'fine')
    git(f.work, baseEnv(), 'tag', 'lw', 'clean')

    const tagged = push(f, 'refs/tags/lw')
    const deleted = push(f, ':refs/tags/lw')

    expect(tagged.code).toBe(0)
    expect(deleted.code).toBe(0)
    expect(remoteTag(f, 'lw')).toBe('')
  })
})

describe('the remote the scan base is read from', () => {
  const REWRITTEN = 'leak-scan: push refused: git config rewrites the push URL'

  /** A bare repo whose HEAD is the leaky commit; the stub scans each sha alone, so these tests need the real scanner. */
  function decoyRemote(f: Fixture): string {
    commitFile(f, 'leaky', 'notes.md', `the ${LEAK} seat`)
    const decoy = path.join(path.dirname(f.work), 'decoy.git')
    git(path.dirname(f.work), baseEnv(), 'init', '-q', '--bare', '-b', 'main', decoy)
    git(f.work, baseEnv(), 'push', '-q', decoy, 'leaky:main')
    return decoy
  }

  // Reads go to the decoy, and the push still goes to the real remote.
  const decoyRules = (f: Fixture, decoy: string): [string, string][] => [
    [`url.${decoy}.insteadOf`, f.remote],
    [`url.${f.remote}.pushInsteadOf`, f.remote],
  ]

  it.each([
    [
      'local url.insteadOf and pushInsteadOf',
      (f: Fixture, rules: [string, string][]) => {
        for (const [key, value] of rules) git(f.work, baseEnv(), 'config', '--add', key, value)
        return []
      },
    ],
    [
      'the two rules as GIT_CONFIG_COUNT entries',
      (f: Fixture, rules: [string, string][]) => {
        f.agentEnv.GIT_CONFIG_COUNT = '3'
        rules.forEach(([key, value], i) =>
          Object.assign(f.agentEnv, {
            [`GIT_CONFIG_KEY_${i + 1}`]: key,
            [`GIT_CONFIG_VALUE_${i + 1}`]: value,
          }),
        )
        return []
      },
    ],
    [
      'the two rules as git -c',
      (_: Fixture, rules: [string, string][]) => rules.flatMap(([k, v]) => ['-c', `${k}=${v}`]),
    ],
  ])('refuses a leaky push when %s point the tip lookup at another repository', (_, plant) => {
    const f = fixture({ scanPath: realScanPath() })
    const gitArgs = plant(f, decoyRules(f, decoyRemote(f)))

    const run = push(f, 'leaky', gitArgs)

    expect(run.code).not.toBe(0)
    expect(run.stdout + run.stderr).toContain('notes.md:1 private-term')
    expect(run.stderr).not.toContain(REWRITTEN)
    expect(remoteHas(f, 'leaky')).toBe(false)
  })

  it("refuses a push when the owner's global config rewrites the push URL", () => {
    const f = fixture({ scanPath: realScanPath() })
    const decoy = decoyRemote(f)
    git(
      f.work,
      baseEnv(),
      'config',
      '--file',
      path.join(f.ownerHome, '.gitconfig'),
      `url.${decoy}.insteadOf`,
      f.remote,
    )

    const run = push(f, 'leaky')

    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain(REWRITTEN)
    expect(remoteHas(f, 'leaky')).toBe(false)
  })

  const ownerConfig = (f: Fixture, key: string, value: string): string =>
    git(f.work, baseEnv(), 'config', '--file', path.join(f.ownerHome, '.gitconfig'), key, value)

  it("refuses a leaky push when the owner's global remote uploadpack points the lookup at a decoy", () => {
    const f = fixture({ scanPath: realScanPath() })
    const decoy = decoyRemote(f)
    const wrapper = path.join(path.dirname(f.work), 'decoy-upload-pack')
    fs.writeFileSync(wrapper, `#!/bin/sh\nexec git-upload-pack '${decoy}'\n`, { mode: 0o755 })
    const url = `file://${f.remote}`
    git(f.work, baseEnv(), 'remote', 'set-url', 'origin', url)
    ownerConfig(f, `remote.${url}.uploadpack`, wrapper)

    const run = push(f, 'leaky')

    expect(run.code).not.toBe(0)
    expect(run.stdout + run.stderr).toContain('notes.md:1 private-term')
    expect(remoteHas(f, 'leaky')).toBe(false)
  })

  it("refuses a push when the owner's global config sets core.sshCommand", () => {
    const f = fixture()
    const ssh = path.join(path.dirname(f.work), 'fake-ssh')
    fs.writeFileSync(ssh, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    ownerConfig(f, 'core.sshCommand', ssh)
    commitFile(f, 'clean', 'notes.md', 'fine')

    const run = push(f, 'clean')

    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain('core.sshCommand')
    expect(remoteHas(f, 'clean')).toBe(false)
  })

  it('still scans a push to a relative-path remote', () => {
    const f = fixture()
    git(f.work, baseEnv(), 'remote', 'set-url', 'origin', path.relative(f.work, f.remote))
    commitFile(f, 'leaky', 'notes.md', `the ${LEAK} seat`)
    commitFile(f, 'clean', 'notes.md', 'fine')
    const [sha, main] = ['clean', 'main'].map(rev => git(f.work, baseEnv(), 'rev-parse', rev))

    const clean = push(f, 'clean')
    const cleanScan = stubSaw(f)[1]
    const leaky = push(f, 'leaky')

    expect(clean).toMatchObject({ code: 0, stderr: '' })
    expect(cleanScan).toBe(`refs/heads/clean ${sha} refs/heads/clean ${main}`)
    expect(leaky.code).not.toBe(0)
    expect(remoteHas(f, 'leaky')).toBe(false)
  })

  it("fetches a remote tip this clone lacks without writing it into the agent's repository", () => {
    const f = fixture()
    const other = path.join(path.dirname(f.work), 'other')
    git(path.dirname(f.work), baseEnv(), 'clone', '-q', f.remote, other)
    git(other, baseEnv(), 'commit', '-q', '--allow-empty', '-m', 'ahead')
    git(other, baseEnv(), 'push', '-q', 'origin', 'main')
    const tip = git(other, baseEnv(), 'rev-parse', 'HEAD')
    commitFile(f, 'clean', 'notes.md', 'fine')
    const sha = git(f.work, baseEnv(), 'rev-parse', 'clean')

    const run = push(f, 'clean')

    expect(run).toMatchObject({ code: 0, stderr: '' })
    expect(stubSaw(f)[1]).toBe(`refs/heads/clean ${sha} refs/heads/clean ${tip}`)
    expect(spawnSync('git', ['cat-file', '-e', tip], { cwd: f.work, env: baseEnv() }).status).not.toBe(0)
  })

  it('takes no tip from a ref that only ends in /HEAD', () => {
    const f = fixture()
    git(f.remote, baseEnv(), 'update-ref', 'refs/heads/x/HEAD', 'main')
    git(f.remote, baseEnv(), 'symbolic-ref', 'HEAD', 'refs/heads/absent')
    commitFile(f, 'clean', 'notes.md', 'fine')

    const run = push(f, 'clean')

    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain('origin names no default branch to scan refs/heads/clean against')
    expect(remoteHas(f, 'clean')).toBe(false)
  })

  /** A git on the broker PATH that logs the remote call's env and fetches, and may answer the tip lookup. */
  const gitStub = (log: string, tipLine?: string): string => `case " $* " in
*' ls-remote '*) env > '${log}.env' ;;
*' fetch '*) echo "fetch $*" >> '${log}' ;;
esac
${tipLine === undefined ? '' : `case " $* " in *' ls-remote '*' HEAD '*) printf '%s\\tHEAD\\n' '${tipLine}'; exit 0 ;; esac`}
exec '${REAL_GIT}' "$@"`

  const stubbedGitFixture = (tipLine?: string): { f: Fixture; log: string } => {
    const log = path.join(fs.mkdtempSync(path.join(SCRATCH, 'git-log-')), 'git.log')
    const scripts = { git: gitStub(log, tipLine) }
    const bin = binWith({ node: true, egress: egressStub(`${log}.scan`), scripts })
    return { f: fixture({ scanPath: `${bin}:${SYSTEM_PATH}` }), log }
  }

  it('says the lookup failed, not that no default branch exists, when ls-remote fails', () => {
    const log = path.join(fs.mkdtempSync(path.join(SCRATCH, 'git-log-')), 'git.log')
    const failing = `case " $* " in *' ls-remote '*' HEAD '*) exit 128 ;; esac\nexec '${REAL_GIT}' "$@"`
    const bin = binWith({ node: true, egress: egressStub(`${log}.scan`), scripts: { git: failing } })
    const f = fixture({ scanPath: `${bin}:${SYSTEM_PATH}` })
    commitFile(f, 'clean', 'notes.md', 'fine')

    const run = push(f, 'clean')

    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain('lookup on')
    expect(run.stderr).not.toContain('names no default branch')
  })

  it('fetches the remote tip without recursing into submodules', () => {
    const { f, log } = stubbedGitFixture()
    const other = path.join(path.dirname(f.work), 'other')
    git(path.dirname(f.work), baseEnv(), 'clone', '-q', f.remote, other)
    git(other, baseEnv(), 'commit', '-q', '--allow-empty', '-m', 'ahead')
    git(other, baseEnv(), 'push', '-q', 'origin', 'main')
    commitFile(f, 'clean', 'notes.md', 'fine')

    const run = push(f, 'clean')

    expect(run.code).toBe(0)
    expect(fs.readFileSync(log, 'utf8')).toContain('--no-recurse-submodules')
  })

  it('ignores a tip that is not hex, and fetches nothing', () => {
    const { f, log } = stubbedGitFixture('--x')
    commitFile(f, 'clean', 'notes.md', 'fine')

    const run = push(f, 'clean')

    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain('origin names no default branch')
    expect(fs.existsSync(log)).toBe(false)
  })

  it('hands the remote call no variable of the agent but SSH_AUTH_SOCK', () => {
    const { f, log } = stubbedGitFixture()
    const scratch = path.dirname(f.chatHome)
    Object.assign(f.agentEnv, {
      HOME: scratch,
      XDG_CONFIG_HOME: scratch,
      GIT_CONFIG_GLOBAL: path.join(scratch, 'agent-gitconfig'),
      GIT_SSH_COMMAND: 'false',
      GIT_ASKPASS: 'false',
      SSH_AUTH_SOCK: path.join(scratch, 'agent.sock'),
      ZQ7_CANARY: '1',
    })
    commitFile(f, 'clean', 'notes.md', 'fine')
    const setByTheShell = new Set(['PWD', 'OLDPWD', 'SHLVL', '_'])

    const run = push(f, 'clean')

    const seen = Object.fromEntries(
      fs
        .readFileSync(`${log}.env`, 'utf8')
        .trim()
        .split('\n')
        .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
        .filter(([name]) => !setByTheShell.has(name ?? '')),
    )
    expect(run.code).toBe(0)
    expect(Object.keys(seen).sort()).toEqual([
      'GIT_DIR',
      'GIT_TERMINAL_PROMPT',
      'HOME',
      'PATH',
      'SSH_AUTH_SOCK',
    ])
    expect(seen).toMatchObject({
      HOME: f.ownerHome,
      SSH_AUTH_SOCK: f.agentEnv.SSH_AUTH_SOCK,
      GIT_TERMINAL_PROMPT: '0',
    })
    expect(seen.GIT_DIR).toMatch(/\/view\/\.git$/)
  })
})

describe("the allow list: the remote default branch's .egress-allow and no other", () => {
  const leak = (f: Fixture, branch: string): void => commitFile(f, branch, 'notes.md', homePathLine)
  const writeAllow = (f: Fixture): void => fs.writeFileSync(path.join(f.work, '.egress-allow'), ALLOW)
  const commitOnTop = (f: Fixture, file: string, text: string): void => {
    fs.writeFileSync(path.join(f.work, file), `${text}\n`)
    git(f.work, baseEnv(), 'add', file)
    git(f.work, baseEnv(), 'commit', '-q', '-m', `add ${file}`)
  }

  it('honours an entry already on the remote default branch', () => {
    const f = fixture({ scanPath: realScanPath() })
    landOnMain(f, '.egress-allow', ALLOW.trim())
    leak(f, 'allowed')

    const run = push(f, 'allowed')

    expect(run).toMatchObject({ code: 0 })
    expect(remoteHas(f, 'allowed')).toBe(true)
  })

  it('honours an entry on the remote default branch that this clone has not fetched', () => {
    const f = fixture({ scanPath: realScanPath() })
    const other = path.join(path.dirname(f.work), 'other')
    git(path.dirname(f.work), baseEnv(), 'clone', '-q', f.remote, other)
    fs.writeFileSync(path.join(other, '.egress-allow'), ALLOW)
    git(other, baseEnv(), 'add', '.egress-allow')
    git(other, baseEnv(), 'commit', '-q', '-m', 'allow notes.md')
    git(other, baseEnv(), 'push', '-q', 'origin', 'main')
    leak(f, 'allowed')

    const run = push(f, 'allowed')

    expect(run).toMatchObject({ code: 0 })
    expect(remoteHas(f, 'allowed')).toBe(true)
  })

  // CC-310 review: each of these reached the remote while the hook compared the worktree file to HEAD.
  it.each([
    [
      'only in the commits being pushed',
      (f: Fixture) => {
        leak(f, 'leaky')
        commitOnTop(f, '.egress-allow', ALLOW.trim())
      },
    ],
    [
      'on an unpushed branch that HEAD is on',
      (f: Fixture) => {
        leak(f, 'leaky')
        commitFile(f, 'holder', '.egress-allow', ALLOW.trim())
      },
    ],
    [
      'a skip-worktree edit of the committed file',
      (f: Fixture) => {
        landOnMain(f, '.egress-allow', '# none yet')
        git(f.work, baseEnv(), 'update-index', '--skip-worktree', '.egress-allow')
        writeAllow(f)
        leak(f, 'leaky')
      },
    ],
    [
      'staged and not committed',
      (f: Fixture) => {
        leak(f, 'leaky')
        writeAllow(f)
        git(f.work, baseEnv(), 'add', '.egress-allow')
      },
    ],
    [
      'untracked',
      (f: Fixture) => {
        leak(f, 'leaky')
        writeAllow(f)
      },
    ],
    [
      'on the remote branch being pushed to, and not on the default branch',
      (f: Fixture) => {
        commitFile(f, 'leaky', '.egress-allow', ALLOW.trim())
        git(f.work, baseEnv(), 'push', '-q', 'origin', 'leaky')
        commitOnTop(f, 'notes.md', homePathLine)
      },
    ],
  ])('refuses a home path whose allow entry is %s', (_, plant) => {
    const f = fixture({ scanPath: realScanPath() })
    plant(f)

    const run = push(f, 'leaky')

    expect(run.code).not.toBe(0)
    expect(run.stdout).toContain('notes.md:1 home-path')
    expect(run.stderr).toContain("only .egress-allow entries already on the remote's default branch count")
    expect(remoteAt(f, 'leaky')).not.toBe(git(f.work, baseEnv(), 'rev-parse', 'leaky'))
  })

  it('refuses a push whose .egress-allow is a symlink to a file outside the repo', () => {
    const f = fixture({ scanPath: realScanPath() })
    const outside = path.join(path.dirname(f.work), 'outside-allow')
    fs.writeFileSync(outside, ALLOW)
    leak(f, 'leaky')
    fs.symlinkSync(outside, path.join(f.work, '.egress-allow'))
    git(f.work, baseEnv(), 'add', '.egress-allow')
    git(f.work, baseEnv(), 'commit', '-q', '-m', 'link the allow list')

    const run = push(f, 'leaky')

    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain('.egress-allow in refs/heads/leaky is not a regular file')
    expect(remoteHas(f, 'leaky')).toBe(false)
  })

  it('reads no entries from a symlink on the remote default branch, and still lets a clean push through', () => {
    const f = fixture({ scanPath: realScanPath() })
    git(f.work, baseEnv(), 'checkout', '-q', 'main')
    fs.symlinkSync('README.md', path.join(f.work, '.egress-allow'))
    git(f.work, baseEnv(), 'add', '.egress-allow')
    git(f.work, baseEnv(), 'commit', '-q', '-m', 'link the allow list')
    git(f.work, baseEnv(), 'push', '-q', 'origin', 'main')
    commitFile(f, 'clean', 'notes.md', 'fine')
    git(f.work, baseEnv(), 'rm', '-q', '.egress-allow')
    git(f.work, baseEnv(), 'commit', '-q', '-m', 'drop the link')

    const run = push(f, 'clean')

    expect(run).toMatchObject({ code: 0 })
    expect(remoteHas(f, 'clean')).toBe(true)
  })
})

// CC-795: each exec leaks kernel buffers, so the hook's own git calls must skip the agent's push guard.
describe('the shim dirs on the broker PATH the pre-push hook bakes in', () => {
  // Every git here, setup included, is the system one: the live agent PATH may hold a git shim.
  const systemGit = execFileSync('sh', ['-c', 'command -v git'], {
    env: { PATH: SYSTEM_PATH },
    encoding: 'utf8',
  }).trim()
  beforeEach(() => vi.stubEnv('PATH', SYSTEM_PATH))
  afterEach(() => vi.unstubAllEnvs())

  const bakedPath = (shim: string): string[] =>
    (/^PATH='([^']*)'; export PATH$/m.exec(shim)?.[1] ?? '').split(':')

  /** node and the scanner stub, with git left to the system dirs after it. */
  const scanTools = (log: string): string => binWith({ node: true, egress: egressStub(log) })

  const rewriteHooks = (f: Fixture, scanPath: string): void =>
    writeGitHooks(path.join(f.chatHome, 'git-hooks'), {
      missingTermsRefuses: true,
      home: f.ownerHome,
      path: scanPath,
    })

  it('drops the git shim dir and every gh shim dir, keeping every other entry in order', () => {
    const chat = path.join(SCRATCH, 'baked-chat')
    const gitBin = path.join(chat, 'git-bin')
    const ghRoot = path.join(chat, 'gh-shim')
    const kept = ['/opt/zq7/git-bin', `${gitBin}-tools`, `${ghRoot}-old`, '/opt/zq7/bin', '/usr/bin', '/bin']
    const input = [
      gitBin,
      path.join(ghRoot, 'a1b2c3'),
      kept[0],
      `${gitBin}/`,
      kept[1],
      kept[2],
      `${chat}/./gh-shim/d4e5f6`,
      ...kept.slice(3),
    ]
    const inputs = { missingTermsRefuses: true, home: HOME, path: input.join(':') }

    const shim = hookScripts(inputs, undefined, [gitBin, ghRoot]).get('pre-push') ?? ''

    expect(bakedPath(shim)).toEqual(kept)
  })

  it('drops them in writeGitHooks whatever PATH the caller passes, gh shim dirs following AGENT_CHAT_HOME', () => {
    const chat = path.join(SCRATCH, 'written-chat')
    vi.stubEnv('AGENT_CHAT_HOME', chat)
    const hooks = path.join(chat, 'git-hooks')
    const scanPath = `${chat}/git-bin:${chat}/gh-shim/a1b2c3:${SYSTEM_PATH}`

    writeGitHooks(hooks, { missingTermsRefuses: true, home: HOME, path: scanPath })

    expect(bakedPath(fs.readFileSync(path.join(hooks, 'pre-push'), 'utf8'))).toEqual(SYSTEM_PATH.split(':'))
  })

  it('refuses every push when no entry is left, rather than baking an empty PATH', () => {
    const f = fixture()
    const gitBin = path.join(f.chatHome, 'git-bin')
    fs.renameSync(scanTools('/dev/null'), gitBin)
    rewriteHooks(f, gitBin)
    commitFile(f, 'clean', 'notes.md', 'fine')

    const run = push(f, 'clean')

    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain('leak-scan: push refused: the broker PATH holds no directory')
    expect(remoteHas(f, 'clean')).toBe(false)
  })

  it('runs no git through a git shim dir that was first on the broker PATH', () => {
    const f = fixture()
    const gitBin = path.join(f.chatHome, 'git-bin')
    const calls = path.join(path.dirname(f.work), 'git-calls')
    fs.mkdirSync(gitBin)
    fs.writeFileSync(
      path.join(gitBin, 'git'),
      [
        '#!/bin/sh',
        `echo "$*" >> '${calls}'`,
        `PATH=$(printf '%s' "$PATH" | tr ':' '\\n' | grep -vxF '${gitBin}' | paste -sd: -)`,
        'export PATH',
        `exec '${systemGit}' "$@"`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
    rewriteHooks(f, `${gitBin}:${scanTools(f.stubLog)}:${SYSTEM_PATH}`)
    commitFile(f, 'clean', 'notes.md', 'fine')

    const run = spawnSync(systemGit, ['push', '-q', 'origin', 'clean'], {
      cwd: f.work,
      env: f.agentEnv,
      encoding: 'utf8',
    })

    expect(run).toMatchObject({ status: 0, stderr: '' })
    expect(remoteHas(f, 'clean')).toBe(true)
    expect(stubSaw(f)[0]).toBe('args=pre-push origin CI=unset REQUIRE=1')
    expect(fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : []).toEqual([])
  })
})

describe('the scan view and the repo hook under a hostile agent env', () => {
  const withGitDir = (f: Fixture): void => {
    f.agentEnv.GIT_DIR = path.join(f.work, '.git')
  }

  it('runs the repo hook with the agent PATH, not the broker PATH the shim bakes in', () => {
    const brokerBin = binWith({ node: true, git: true, egress: egressStub() })
    const f = fixture({ scanPath: `${brokerBin}:${SYSTEM_PATH}` })
    const agentBin = binWith({})
    const seen = path.join(path.dirname(f.work), 'hook-path')
    fs.writeFileSync(
      path.join(f.work, '.git', 'hooks', 'pre-push'),
      `#!/bin/sh\nprintf '%s' "$PATH" > '${seen}'\n`,
      { mode: 0o755 },
    )
    f.agentEnv.PATH = `${agentBin}:${process.env.PATH}`
    commitFile(f, 'clean', 'notes.md', 'fine')

    const run = push(f, 'clean')

    expect(run).toMatchObject({ code: 0 })
    const hookPath = fs.readFileSync(seen, 'utf8').split(':')
    expect(hookPath).toContain(agentBin)
    expect(hookPath).not.toContain(brokerBin)
  })

  it('still refuses a symlinked .egress-allow when the agent env holds GIT_DIR and a replace ref hides it', () => {
    const f = fixture()
    const outside = path.join(path.dirname(f.work), 'outside-allow')
    fs.writeFileSync(outside, 'notes.md\n')
    commitFile(f, 'linked', 'notes.md', 'fine')
    fs.symlinkSync(outside, path.join(f.work, '.egress-allow'))
    git(f.work, baseEnv(), 'add', '.egress-allow')
    git(f.work, baseEnv(), 'commit', '-q', '-m', 'link the allow list')
    git(f.work, baseEnv(), 'replace', 'linked', 'main')
    withGitDir(f)

    const run = push(f, 'linked')

    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain('.egress-allow in refs/heads/linked is not a regular file')
    expect(remoteHas(f, 'linked')).toBe(false)
  })

  it('lets a clean push through with GIT_DIR in the agent env, and leaves the agent repository as it was', () => {
    const f = fixture()
    commitFile(f, 'clean', 'notes.md', 'fine')
    withGitDir(f)
    const alternates = path.join(f.work, '.git', 'objects', 'info', 'alternates')

    const run = push(f, 'clean')

    expect(run).toMatchObject({ code: 0, stderr: '' })
    expect(remoteHas(f, 'clean')).toBe(true)
    expect(fs.existsSync(alternates)).toBe(false)
  })
})

// Run directly: a push to a local path starts receive-pack through sh, which noexec also stops.
describe.each(['/bin/dash', '/bin/sh', '/bin/bash'].filter(shell => fs.existsSync(shell)))(
  'the repo pre-push hook under a hostile SHELLOPTS with the guard shim on %s',
  shell => {
    it.each(['#!/bin/sh', '#!/bin/bash'])(
      'still runs a %s hook that refuses, so the shim exits nonzero',
      shebang => {
        const f = fixture({ shell })
        fs.writeFileSync(
          path.join(f.work, '.git', 'hooks', 'pre-push'),
          `${shebang}\necho ran >> '${f.marker}'\nexit 7\n`,
          { mode: 0o755 },
        )
        commitFile(f, 'clean', 'notes.md', 'fine')
        const sha = git(f.work, baseEnv(), 'rev-parse', 'clean')

        const run = spawnSync(path.join(f.chatHome, 'git-hooks', 'pre-push'), ['origin', f.remote], {
          cwd: f.work,
          env: { ...f.agentEnv, SHELLOPTS: 'xtrace:noexec', BASHOPTS: 'extglob' },
          input: `refs/heads/clean ${sha} refs/heads/clean ${'0'.repeat(40)}\n`,
          encoding: 'utf8',
        })

        expect(repoHookRuns(f)).toEqual(['ran'])
        expect(run.status).toBe(7)
      },
    )
  },
)
