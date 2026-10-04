import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prReady, spawnRun, type PrReadyOptions, type Run } from '../cli/verbs/pr-ready.js'

const BASE = 'refs/remotes/origin/main'
const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), content)
  }
}

function commit(dir: string, files: Record<string, string>, message: string): void {
  writeFiles(dir, files)
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message)
}

/** A synthetic repo with a bare origin, origin/HEAD set, and a feature branch off main. */
function fixtureRepo(base: Record<string, string>, feature: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-ready-'))
  tmpDirs.push(root)
  const hooks = path.join(root, 'no-hooks')
  const work = path.join(root, 'work')
  fs.mkdirSync(hooks)
  git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git')
  git(root, 'init', '-q', '-b', 'main', 'work')
  for (const [key, value] of [
    ['user.name', 'Fixture'],
    ['user.email', 'fixture@example.invalid'],
    ['commit.gpgsign', 'false'],
    ['core.hooksPath', hooks],
  ]) {
    git(work, 'config', key, value)
  }
  commit(work, { 'shared.txt': 'base\n', ...base }, 'base')
  git(work, 'remote', 'add', 'origin', path.join(root, 'origin.git'))
  git(work, 'push', '-q', 'origin', 'main')
  git(work, 'remote', 'set-head', 'origin', 'main')
  git(work, 'checkout', '-q', '-b', 'feature')
  commit(work, feature, 'feature')
  return work
}

/** Advances origin/main from the work repo, leaving the feature branch checked out. */
function advanceOrigin(work: string, files: Record<string, string>): void {
  git(work, 'checkout', '-q', 'main')
  commit(work, files, 'upstream')
  git(work, 'push', '-q', 'origin', 'main')
  git(work, 'checkout', '-q', 'feature')
}

/** Real git; every package-manager call is recorded and answered from `failing`. */
function recorder(failing: string[] = []) {
  const calls: string[] = []
  const run: Run = async (cmd, args, cwd) => {
    const line = [cmd, ...args].join(' ')
    calls.push(line)
    if (cmd === 'git') return spawnRun(cmd, args, cwd)
    return failing.includes(line)
      ? { code: 1, output: `synthetic failure: ${line}` }
      : { code: 0, output: '' }
  }
  return { run, calls }
}

async function runPrReady(cwd: string, failing: string[] = [], opts: PrReadyOptions = {}) {
  const { run, calls } = recorder(failing)
  const out: string[] = []
  const errLines: string[] = []
  const code = await prReady(opts, {
    run,
    cwd,
    out: line => out.push(line),
    err: line => errLines.push(line),
  })
  return { code, out, calls, errLines, toolCalls: calls.filter(call => !call.startsWith('git ')) }
}

const pkg = (body: object): string => JSON.stringify(body, null, 2)

interface Kind {
  name: string
  base: Record<string, string>
  feature: Record<string, string>
  checks: string[]
  failingCheck: string
  changeset: string
}

const KINDS: Kind[] = [
  {
    name: 'npm',
    base: { 'package.json': pkg({ name: 'fixture-npm', scripts: { lint: 'x', typecheck: 'x', test: 'x' } }) },
    feature: { 'src/a.ts': 'export const a = 1\n' },
    checks: ['npm run lint', 'npm run typecheck'],
    failingCheck: 'npm run lint',
    changeset: `npx changeset status --since=${BASE}`,
  },
  {
    name: 'pnpm single package',
    base: {
      'package.json': pkg({ name: 'fixture-pnpm', scripts: { 'format:check': 'x', 'type-check': 'x' } }),
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    },
    feature: { 'src/a.ts': 'export const a = 1\n' },
    checks: ['pnpm run format:check', 'pnpm run type-check'],
    failingCheck: 'pnpm run type-check',
    changeset: `pnpm changeset status --since=${BASE}`,
  },
  {
    name: 'pnpm workspace',
    base: {
      'package.json': pkg({
        name: 'fixture-root',
        scripts: { lint: 'pnpm -r lint', typecheck: 'turbo run typecheck', 'capabilities:check': 'x' },
      }),
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
      'packages/alpha/package.json': pkg({ name: '@fixture/alpha', scripts: { lint: 'x', typecheck: 'x' } }),
      'packages/beta/package.json': pkg({ name: '@fixture/beta', scripts: { lint: 'x' } }),
      'packages/gamma/package.json': pkg({ name: '@fixture/gamma', scripts: { 'format:check': 'x' } }),
    },
    feature: {
      'packages/alpha/src/deep/a.ts': 'export const a = 1\n',
      'packages/beta/b.ts': '1\n',
      'README.md': 'r\n',
    },
    checks: [
      'pnpm --filter @fixture/alpha run lint',
      'pnpm --filter @fixture/alpha run typecheck',
      'pnpm --filter @fixture/beta run lint',
      'pnpm run capabilities:check',
    ],
    failingCheck: 'pnpm --filter @fixture/beta run lint',
    changeset: `pnpm changeset status --since=${BASE}`,
  },
]

describe.each(KINDS)('pr-ready in a $name fixture repo', kind => {
  const repo = (extra: Record<string, string> = {}) => fixtureRepo({ ...kind.base, ...extra }, kind.feature)
  const withChangeset = { '.changeset/config.json': '{}\n' }

  it('passes every step, runs only the discovered checks and prints the head sha', async () => {
    const work = repo()

    const result = await runPrReady(work)

    expect(result.code).toBe(0)
    expect(result.out).toEqual([
      'ok clean-tree',
      `ok base: ${BASE}`,
      'ok rebase',
      'ok checks',
      'ok changeset: not configured',
      `PR-READY OK ${git(work, 'rev-parse', 'HEAD')}`,
    ])
    expect(result.toolCalls).toEqual(kind.checks)
  })

  it('fails the checks step naming the failing command, and still runs the rest', async () => {
    const result = await runPrReady(repo(), [kind.failingCheck])

    expect(result.code).toBe(1)
    expect(result.out).toContain(`FAIL checks: failed: ${kind.failingCheck}`)
    expect(result.out.at(-1)).toBe('PR-READY FAIL')
    expect(result.toolCalls).toEqual(kind.checks)
    expect(result.errLines).toEqual([`synthetic failure: ${kind.failingCheck}`])
  })

  it('passes the changeset step when changeset status succeeds', async () => {
    const result = await runPrReady(repo(withChangeset))

    expect(result.code).toBe(0)
    expect(result.out).toContain('ok changeset')
    expect(result.toolCalls.at(-1)).toBe(kind.changeset)
  })

  it('fails the changeset step when changeset status fails', async () => {
    const result = await runPrReady(repo(withChangeset), [kind.changeset])

    expect(result.code).toBe(1)
    expect(result.out).toContain(`FAIL changeset: synthetic failure: ${kind.changeset}`)
    expect(result.out.at(-1)).toBe('PR-READY FAIL')
  })

  it('fails a dirty tree before any fetch, rebase or check', async () => {
    const work = repo()
    fs.writeFileSync(path.join(work, 'shared.txt'), 'edited\n')
    fs.writeFileSync(path.join(work, 'untracked.txt'), 'new\n')

    const result = await runPrReady(work)

    expect(result.code).toBe(1)
    expect(result.out).toEqual([
      'FAIL clean-tree: uncommitted changes in shared.txt, untracked.txt',
      'PR-READY FAIL',
    ])
    expect(result.calls).toEqual(['git status --porcelain'])
  })

  it('rebases onto an advanced origin before running the checks', async () => {
    const work = repo()
    advanceOrigin(work, { 'upstream.txt': 'u\n' })
    const upstream = git(work, 'rev-parse', BASE)

    const result = await runPrReady(work)

    expect(result.code).toBe(0)
    expect(result.out).toContain('ok rebase')
    expect(git(work, 'rev-parse', 'HEAD~1')).toBe(upstream)
  })

  it('aborts a conflicting rebase, lists the files and runs no checks', async () => {
    const work = repo()
    commit(work, { 'shared.txt': 'feature side\n' }, 'feature edit')
    advanceOrigin(work, { 'shared.txt': 'upstream side\n' })
    const before = git(work, 'rev-parse', 'HEAD')

    const result = await runPrReady(work)

    expect(result.code).toBe(1)
    expect(result.out).toContain('FAIL rebase: conflict in shared.txt; rebase aborted')
    expect(result.out.at(-1)).toBe('PR-READY FAIL')
    expect(result.calls).toContain('git rebase --abort')
    expect(result.toolCalls).toEqual([])
    expect(git(work, 'rev-parse', 'HEAD')).toBe(before)
    expect(git(work, 'status', '--porcelain')).toBe('')
  })
})

describe('pr-ready in a pnpm workspace', () => {
  it('never runs pnpm -r, turbo or a root check script', async () => {
    const workspace = KINDS[2]!
    const result = await runPrReady(fixtureRepo(workspace.base, workspace.feature))

    const fanOut = result.toolCalls.filter(
      call => /\s-r(\s|$)|--recursive|turbo/.test(call) || /^pnpm run (lint|typecheck)$/.test(call),
    )
    expect(fanOut).toEqual([])
    expect(result.toolCalls).not.toContain('pnpm --filter @fixture/gamma run format:check')
  })

  it('names pnpm capabilities when capabilities:check fails', async () => {
    const workspace = KINDS[2]!
    const result = await runPrReady(fixtureRepo(workspace.base, workspace.feature), [
      'pnpm run capabilities:check',
    ])

    expect(result.out).toContain('FAIL checks: failed: pnpm run capabilities:check (run pnpm capabilities)')
  })

  it('reports no scripts when no changed package has a check script', async () => {
    const work = fixtureRepo(
      {
        'package.json': pkg({ name: 'fixture-root' }),
        'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
        'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
        'packages/delta/package.json': pkg({ name: '@fixture/delta', scripts: { build: 'x' } }),
      },
      { 'packages/delta/index.ts': '1\n' },
    )

    const result = await runPrReady(work)

    expect(result.out).toContain('ok checks: no scripts')
    expect(result.toolCalls).toEqual([])
  })
})

describe('pr-ready options and discovery', () => {
  it('runs only a root pr-ready script when one exists', async () => {
    const work = fixtureRepo(
      { 'package.json': pkg({ scripts: { 'pr-ready': 'x', lint: 'x' } }) },
      { 'a.txt': '1\n' },
    )

    const result = await runPrReady(work)

    expect(result.toolCalls).toEqual(['npm run pr-ready'])
  })

  it('prints ok checks: no scripts for a package with none of the scripts', async () => {
    const work = fixtureRepo({ 'package.json': pkg({ scripts: { test: 'x' } }) }, { 'a.txt': '1\n' })

    const result = await runPrReady(work)

    expect(result.code).toBe(0)
    expect(result.out).toContain('ok checks: no scripts')
  })

  it('skips the fetch and rebase with --no-rebase', async () => {
    const work = fixtureRepo({ 'package.json': pkg({}) }, { 'a.txt': '1\n' })

    const result = await runPrReady(work, [], { rebase: false })

    expect(result.out).toContain('ok rebase: skipped (--no-rebase)')
    expect(result.calls.some(call => call.startsWith('git rebase') || call.startsWith('git fetch'))).toBe(
      false,
    )
  })

  it('accepts --title and --body-file and leaves the scan to CC-687', async () => {
    const work = fixtureRepo({ 'package.json': pkg({}) }, { 'a.txt': '1\n' })

    const result = await runPrReady(work, [], { title: 'Synthetic title', bodyFile: 'body.md' })

    expect(result.code).toBe(0)
    expect(result.out).toContain('ok body: scan lands with CC-687')
  })

  it('uses the full remote ref, so a local branch named origin/main cannot shadow it', async () => {
    const work = fixtureRepo({ 'package.json': pkg({}) }, { 'a.txt': '1\n' })
    git(work, 'branch', 'origin/main', 'feature')
    advanceOrigin(work, { 'upstream.txt': 'u\n' })

    const result = await runPrReady(work)

    expect(result.code).toBe(0)
    expect(git(work, 'rev-parse', 'HEAD~1')).toBe(git(work, 'rev-parse', BASE))
  })

  it('fails the base step when origin/HEAD is not set', async () => {
    const work = fixtureRepo({ 'package.json': pkg({}) }, { 'a.txt': '1\n' })
    git(work, 'remote', 'set-head', 'origin', '--delete')

    const result = await runPrReady(work)

    expect(result.code).toBe(1)
    expect(result.out).toEqual([
      'ok clean-tree',
      'FAIL base: no origin/HEAD; run git remote set-head origin --auto',
      'PR-READY FAIL',
    ])
  })
})
