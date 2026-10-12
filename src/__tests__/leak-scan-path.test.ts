import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { defaultScanInputs, gitHooksEnv, termsFileFor, writeGitHooks } from '../leak-guard/hooks-dir.js'
import { ownToolDirs, withOwnTools } from '../leak-guard/scan-path.js'

const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-scanpath-')))

afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }))

const SYSTEM_PATH = '/usr/bin:/bin'
const NODE_DIR = path.dirname(process.execPath)
const OWN_BIN = path.resolve('node_modules', '.bin')
// Synthetic marker term; nothing real.
const LEAK = 'zq7leakterm'

/** A fake install: node_modules/@titan-design/egress-scan with a .bin link, pointing where `binTarget` says. */
function fakeInstall(binTarget: 'own' | 'elsewhere'): { resolve: (s: string) => string; binDir: string } {
  const nodeModules = path.join(fs.mkdtempSync(path.join(SCRATCH, 'install-')), 'node_modules')
  const dist = path.join(nodeModules, '@titan-design', 'egress-scan', 'dist')
  const binDir = path.join(nodeModules, '.bin')
  fs.mkdirSync(dist, { recursive: true })
  fs.mkdirSync(binDir)
  fs.writeFileSync(path.join(dist, 'index.js'), '')
  fs.writeFileSync(path.join(dist, 'bin.js'), '')
  fs.writeFileSync(path.join(SCRATCH, 'other.js'), '')
  const target = binTarget === 'own' ? path.join(dist, 'bin.js') : path.join(SCRATCH, 'other.js')
  fs.symlinkSync(target, path.join(binDir, 'titan-egress-scan'))
  return { resolve: () => pathToFileURL(path.join(dist, 'index.js')).href, binDir }
}

describe('ownToolDirs', () => {
  it("finds agent-chat's own installed scanner dir and node's dir", () => {
    expect(ownToolDirs()).toEqual([OWN_BIN, NODE_DIR])
  })

  it('keeps a .bin dir whose titan-egress-scan is the resolved package', () => {
    const { resolve, binDir } = fakeInstall('own')

    expect(ownToolDirs(resolve)).toEqual([binDir, NODE_DIR])
  })

  it('drops a .bin dir whose titan-egress-scan resolves elsewhere', () => {
    expect(ownToolDirs(fakeInstall('elsewhere').resolve)).toEqual([NODE_DIR])
  })

  it("returns only node's dir when the scanner package cannot be resolved", () => {
    const resolve = (): string => {
      throw new Error('Cannot find package')
    }

    expect(ownToolDirs(resolve)).toEqual([NODE_DIR])
  })
})

describe('withOwnTools', () => {
  it("keeps the broker's entries first and adds each own dir once", () => {
    expect(withOwnTools('/opt/a:/usr/bin', ['/own/bin', '/usr/bin', '/own/bin'])).toBe(
      '/opt/a:/usr/bin:/own/bin',
    )
  })

  it('adds no relative dir', () => {
    expect(withOwnTools('/usr/bin', ['relative/bin', '.'])).toBe('/usr/bin')
  })
})

describe('git push when the broker PATH lacks titan-egress-scan', () => {
  afterEach(() => vi.unstubAllEnvs())

  const env = (): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH,
    HOME: path.join(SCRATCH, 'agent-home'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Probe',
    GIT_AUTHOR_EMAIL: 'probe@example.com',
    GIT_COMMITTER_NAME: 'Probe',
    GIT_COMMITTER_EMAIL: 'probe@example.com',
  })
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, env: env(), encoding: 'utf8' }).trim()

  function leakyRepo(root: string): string {
    const [work, remote] = ['work', 'remote.git'].map(d => path.join(root, d)) as [string, string]
    git(root, 'init', '-q', '--bare', '-b', 'main', remote)
    git(root, 'init', '-q', '-b', 'main', work)
    git(work, 'remote', 'add', 'origin', remote)
    fs.writeFileSync(path.join(work, 'README.md'), 'hello\n')
    git(work, 'add', 'README.md')
    git(work, 'commit', '-q', '-m', 'init')
    git(work, 'push', '-q', 'origin', 'main')
    git(work, 'checkout', '-q', '-b', 'leaky')
    fs.writeFileSync(path.join(work, 'notes.md'), `the ${LEAK} seat\n`)
    git(work, 'add', 'notes.md')
    git(work, 'commit', '-q', '-m', 'add notes')
    return work
  }

  it("refuses a leaky push with agent-chat's own scanner instead of letting it through unscanned", () => {
    const onSystemPath = SYSTEM_PATH.split(':').some(dir =>
      fs.existsSync(path.join(dir, 'titan-egress-scan')),
    )
    if (onSystemPath) return
    const root = fs.mkdtempSync(path.join(SCRATCH, 'repo-'))
    const work = leakyRepo(root)
    const ownerHome = path.join(root, 'owner-home')
    fs.mkdirSync(path.dirname(termsFileFor(ownerHome)), { recursive: true })
    fs.writeFileSync(termsFileFor(ownerHome), `${LEAK}\n`, { mode: 0o600 })
    vi.stubEnv('PATH', SYSTEM_PATH)
    const inputs = { ...defaultScanInputs(), home: ownerHome }
    const hooksDir = path.join(root, 'git-hooks')
    writeGitHooks(hooksDir, inputs)

    const run = spawnSync('git', ['push', '-q', 'origin', 'leaky'], {
      cwd: work,
      env: { ...env(), ...gitHooksEnv(hooksDir) },
      encoding: 'utf8',
    })

    expect(inputs.path).toBe(withOwnTools(SYSTEM_PATH, [OWN_BIN, NODE_DIR]))
    expect(inputs.path.split(':')).toContain(OWN_BIN)
    expect(run.stderr).not.toContain('guard NOT run')
    // The hook prints this line only when the scanner exits 1, a finding.
    expect(run.stderr).toContain(
      "leak-scan: only .egress-allow entries already on the remote's default branch count",
    )
    expect(run.status).toBe(1)
    expect(git(path.join(root, 'remote.git'), 'branch', '--list', 'leaky')).toBe('')
  })
})
