import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
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
exit: 0 clean, 1 findings, 2 usage or configuration error`

// Every fixture is synthetic: a made-up home and a made-up marker term.
const HOME = '/Users/zq7-probe-home'
const LEAK = 'zq7leakterm'

/**
 * Mirrors titan-egress-scan 0.1.0: a CI value skips the term list, a missing list exits 2 only under
 * TITAN_EGRESS_REQUIRE_TERMS=1, and a pushed commit holding the marker is a finding (exit 1).
 */
const EGRESS_STUB = `[ "$1" = --help ] && { cat <<'EOF'
${HELP}
EOF
exit 0; }
[ "$1" = pre-push ] || exit 2
refs=$(cat)
printf 'args=%s CI=%s REQUIRE=%s\\n%s\\n' "$*" "\${CI-unset}" "\${TITAN_EGRESS_REQUIRE_TERMS-unset}" "$refs" > "\${STUB_LOG:-/dev/null}"
terms=\${TITAN_EGRESS_TERMS:-\${XDG_CONFIG_HOME:-$HOME/.config}/titan-egress/private-terms}
case \${CI:-} in
'' | false | 0)
  if [ ! -f "$terms" ]; then
    [ "\${TITAN_EGRESS_REQUIRE_TERMS:-}" = 1 ] && { echo 'titan-egress-scan: private term list not found and TITAN_EGRESS_REQUIRE_TERMS=1' >&2; exit 2; }
    echo 'titan-egress-scan: private term list not found; generic rules only' >&2
  fi ;;
esac
for sha in $(printf '%s\\n' "$refs" | awk '{ print $2 }'); do
  grep -q ${LEAK} "$terms" 2>/dev/null && git show "$sha" | grep -q ${LEAK} && { echo 'commit 1 notes.md:1 private-term'; exit 1; }
done
exit 0`

/** A PATH dir holding only the named tools, so a test controls what the hook can find. */
function binWith(tools: { node?: boolean; git?: boolean; egress?: string }): string {
  const dir = fs.mkdtempSync(path.join(SCRATCH, 'bin-'))
  if (tools.node) fs.symlinkSync(process.execPath, path.join(dir, 'node'))
  if (tools.git)
    fs.symlinkSync(
      execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(),
      path.join(dir, 'git'),
    )
  if (tools.egress !== undefined)
    fs.writeFileSync(path.join(dir, 'titan-egress-scan'), `#!/bin/sh\n${tools.egress}\n`, { mode: 0o755 })
  return dir
}

const SYSTEM_PATH = '/usr/bin:/bin'
const GUARD_PATH = `${binWith({ node: true, git: true, egress: EGRESS_STUB })}:${SYSTEM_PATH}`

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
  git(root, baseEnv(), 'init', '-q', '--bare', remote)
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
  writeGitHooks(hooksDir, {
    missingTermsRefuses: opts.missingTermsRefuses ?? MISSING_TERMS_REFUSES,
    home: ownerHome,
    path: opts.scanPath ?? GUARD_PATH,
  })
  const stubLog = path.join(root, 'stub.log')
  const agentEnv = { ...baseEnv(), ...gitHooksEnv(hooksDir), STUB_LOG: stubLog }
  return { work, remote, chatHome, marker, stubLog, termsFile, agentEnv }
}

function push(f: Fixture, branch: string): { code: number; stdout: string; stderr: string } {
  const run = spawnSync('git', ['push', '-q', 'origin', branch], {
    cwd: f.work,
    env: f.agentEnv,
    encoding: 'utf8',
  })
  return { code: run.status ?? -1, stdout: run.stdout, stderr: run.stderr }
}

const remoteHas = (f: Fixture, branch: string): boolean =>
  spawnSync('git', ['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { cwd: f.remote, env: baseEnv() })
    .status === 0

const repoHookRuns = (f: Fixture): string[] =>
  fs.existsSync(f.marker) ? fs.readFileSync(f.marker, 'utf8').trim().split('\n') : []

const stubSaw = (f: Fixture): string[] => fs.readFileSync(f.stubLog, 'utf8').trim().split('\n')

describe('git push under the agent env', () => {
  it('points core.hooksPath at the guard dir', () => {
    const f = fixture()

    expect(git(f.work, f.agentEnv, 'config', 'core.hooksPath')).toBe(path.join(f.chatHome, 'git-hooks'))
    expect(git(f.work, baseEnv(), 'config', '--default', 'none', 'core.hooksPath')).toBe('none')
  })

  it("lets a clean push through, feeding egress-scan the remote and git's ref lines, and runs the repo hook", () => {
    const f = fixture()
    commitFile(f, 'clean', 'notes.md', 'nothing private')
    const sha = git(f.work, baseEnv(), 'rev-parse', 'clean')

    const run = push(f, 'clean')

    expect(run).toMatchObject({ code: 0, stderr: '' })
    expect(remoteHas(f, 'clean')).toBe(true)
    expect(repoHookRuns(f)).toEqual(['origin refs/heads/clean'])
    expect(stubSaw(f)).toEqual([
      'args=pre-push origin CI= REQUIRE=1',
      `refs/heads/clean ${sha} refs/heads/clean ${'0'.repeat(40)}`,
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
    expect(stubSaw(f)[0]).toBe('args=pre-push origin CI= REQUIRE=1')
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
  /** A PATH whose titan-egress-scan is the given stub script, beside node and git. */
  const pathWithStub = (script?: string): string =>
    [
      binWith({ node: true, git: true, ...(script === undefined ? {} : { egress: script }) }),
      SYSTEM_PATH,
    ].join(':')

  const pathWithout = (tool: 'node' | 'titan-egress-scan'): string =>
    tool === 'node' ? [binWith({ git: true, egress: EGRESS_STUB }), SYSTEM_PATH].join(':') : pathWithStub()

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
