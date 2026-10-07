import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runGh, runGhWrite } from '../cli/gh-write.js'
import { scanDeps } from '../gh-write/scan.js'
import {
  prReady,
  signalTrap,
  spawnRun,
  type PrReadyOptions,
  type Run,
  type RunResult,
  type Trap,
} from '../cli/verbs/pr-ready.js'

const BASE = 'refs/remotes/origin/main'
// Synthetic only: a made-up private term, never a real one.
const TERM = 'zq7privateseat'
const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function configure(repo: string): void {
  for (const [key, value] of Object.entries({
    'user.name': 'Fixture',
    'user.email': 'fixture@example.invalid',
    'commit.gpgsign': 'false',
  })) {
    git(repo, 'config', key, value)
  }
}

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

const originOf = (work: string): string => path.join(path.dirname(work), 'origin')

/**
 * A synthetic origin repo and a clone of it on a feature branch. Upstream commits go straight
 * into the origin, so the fixture never pushes and only pr-ready's own fetch updates the clone.
 */
function fixtureRepo(base: Record<string, string>, feature: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-ready-'))
  tmpDirs.push(root)
  const work = path.join(root, 'work')
  git(root, 'init', '-q', '-b', 'main', 'origin')
  configure(originOf(work))
  commit(originOf(work), { 'shared.txt': 'base\n', ...base }, 'base')
  git(root, 'clone', '-q', originOf(work), work)
  configure(work)
  git(work, 'checkout', '-q', '-b', 'feature')
  commit(work, feature, 'feature')
  return work
}

const advanceOrigin = (work: string, files: Record<string, string>): void =>
  commit(originOf(work), files, 'upstream')

const rebaseInProgress = (work: string): boolean =>
  ['rebase-merge', 'rebase-apply'].some(dir => fs.existsSync(path.join(work, '.git', dir)))

type Override = (line: string, args: string[], cwd: string) => Promise<RunResult> | undefined

/** Real git; every package-manager call is recorded and answered from `failing`. */
function recorder(failing: string[], override?: Override) {
  const calls: string[] = []
  const run: Run = async (cmd, args, cwd) => {
    const line = [cmd, ...args].join(' ')
    calls.push(line)
    const overridden = override?.(line, args, cwd)
    if (overridden) return overridden
    if (cmd === 'git') return spawnRun(cmd, args, cwd)
    return failing.includes(line)
      ? { code: 1, output: `synthetic failure: ${line}` }
      : { code: 0, output: '' }
  }
  return { run, calls }
}

function scratchDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-ready-scan-'))
  tmpDirs.push(dir)
  return dir
}

function syntheticTerms(): string {
  const file = path.join(scratchDir(), 'private-terms')
  fs.writeFileSync(file, `${TERM}\n`)
  return file
}

interface Extra {
  override?: Override
  trap?: Trap
  termsFile?: string
  env?: NodeJS.ProcessEnv
}

async function runPrReady(cwd: string, failing: string[] = [], opts: PrReadyOptions = {}, extra: Extra = {}) {
  const { run, calls } = recorder(failing, extra.override)
  const out: string[] = []
  const errLines: string[] = []
  const code = await prReady(opts, {
    run,
    cwd,
    out: line => out.push(line),
    err: line => errLines.push(line),
    trap: extra.trap ?? (() => () => {}),
    termsFile: extra.termsFile ?? syntheticTerms(),
    env: extra.env ?? { AGENT_CHAT_BASEMENT_HOST: 'off' },
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

const WORKSPACE_BASE = {
  'package.json': pkg({
    name: 'fixture-root',
    scripts: { lint: 'pnpm -r lint', typecheck: 'turbo run typecheck', 'capabilities:check': 'x' },
  }),
  'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
  'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - '!packages/internal'\n",
  'packages/alpha/package.json': pkg({ name: '@fixture/alpha', scripts: { lint: 'x', typecheck: 'x' } }),
  'packages/beta/package.json': pkg({ name: '@fixture/beta', scripts: { lint: 'x' } }),
  'packages/gamma/package.json': pkg({ name: '@fixture/gamma', scripts: { 'format:check': 'x' } }),
}

const KINDS: Kind[] = [
  {
    name: 'npm',
    base: { 'package.json': pkg({ name: 'fixture-npm', scripts: { lint: 'x', typecheck: 'x', test: 'x' } }) },
    feature: { 'src/a.ts': 'export const a = 1\n' },
    checks: ['npm run lint', 'npm run typecheck'],
    failingCheck: 'npm run lint',
    changeset: `npx --no-install @changesets/cli status --since=${BASE}`,
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
    changeset: `pnpm exec changeset status --since=${BASE}`,
  },
  {
    name: 'pnpm workspace',
    base: WORKSPACE_BASE,
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
    changeset: `pnpm exec changeset status --since=${BASE}`,
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
      'ok scan: skipped (no body file)',
      `PR-READY OK ${git(work, 'rev-parse', 'HEAD')} (scan skipped: no body file)`,
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

  it('fetches and rebases onto an advanced origin before running the checks', async () => {
    const work = repo()
    advanceOrigin(work, { 'upstream.txt': 'u\n' })

    const result = await runPrReady(work)

    expect(result.code).toBe(0)
    expect(result.out).toContain('ok rebase')
    expect(git(work, 'rev-parse', 'HEAD~1')).toBe(git(originOf(work), 'rev-parse', 'HEAD'))
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
    expect(rebaseInProgress(work)).toBe(false)
    expect(git(work, 'rev-parse', 'HEAD')).toBe(before)
  })
})

describe('pr-ready in a pnpm workspace', () => {
  const workspaceRepo = (extraBase: Record<string, string>, feature: Record<string, string>) =>
    fixtureRepo({ ...WORKSPACE_BASE, ...extraBase }, feature)

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

  it('climbs past a nameless nested package.json to the member that holds it', async () => {
    const work = workspaceRepo(
      { 'packages/alpha/fixtures/package.json': pkg({ type: 'module' }) },
      { 'packages/alpha/fixtures/data/x.json': '{}\n' },
    )

    const result = await runPrReady(work)

    expect(result.code).toBe(0)
    expect(result.toolCalls).toContain('pnpm --filter @fixture/alpha run lint')
  })

  it('climbs past a named non-member package nested in a member', async () => {
    const work = workspaceRepo(
      { 'packages/alpha/examples/demo/package.json': pkg({ name: '@fixture/demo', scripts: { lint: 'x' } }) },
      { 'packages/alpha/examples/demo/x.ts': '1\n' },
    )

    const result = await runPrReady(work)

    expect(result.code).toBe(0)
    expect(result.toolCalls).toContain('pnpm --filter @fixture/alpha run lint')
    expect(result.toolCalls.some(call => call.includes('@fixture/demo'))).toBe(false)
  })

  it.each([
    ['outside every workspace glob', 'examples/demo', '@fixture/demo'],
    ['excluded by a negated glob', 'packages/internal', '@fixture/internal'],
  ])('fails a changed file in a named package %s', async (_, dir, name) => {
    const work = workspaceRepo(
      { [`${dir}/package.json`]: pkg({ name, scripts: { lint: 'x' } }) },
      { [`${dir}/x.ts`]: '1\n' },
    )

    const result = await runPrReady(work)

    expect(result.code).toBe(1)
    expect(result.out).toContain(`FAIL checks: ${dir}/x.ts is in ${dir}, not a workspace member`)
    expect(result.toolCalls.some(call => call.includes(name))).toBe(false)
  })

  it('maps a non-ASCII path to its member', async () => {
    const work = workspaceRepo({}, { 'packages/beta/ünïcödé.ts': '1\n' })

    const result = await runPrReady(work)

    expect(result.toolCalls).toEqual(['pnpm --filter @fixture/beta run lint', 'pnpm run capabilities:check'])
  })

  it('reports no scripts when no changed package has a check script', async () => {
    const work = fixtureRepo(
      {
        'package.json': pkg({ name: 'fixture-root' }),
        'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
        'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
        'packages/delta/package.json': pkg({ name: '@fixture/delta', scripts: { build: 'x' } }),
      },
      { 'packages/delta/index.ts': '1\n', 'docs/notes.md': 'root-only\n' },
    )

    const result = await runPrReady(work)

    expect(result.out).toContain('ok checks: no scripts')
    expect(result.toolCalls).toEqual([])
  })
})

describe('pr-ready rebase recovery', () => {
  const conflictingRepo = (): string => {
    const work = fixtureRepo({ 'package.json': pkg({}) }, { 'a.txt': '1\n' })
    commit(work, { 'shared.txt': 'feature side\n' }, 'feature edit')
    advanceOrigin(work, { 'shared.txt': 'upstream side\n' })
    return work
  }

  it('reports a rebase still in progress when git rebase --abort fails', async () => {
    const work = conflictingRepo()
    const failAbort: Override = line =>
      line === 'git rebase --abort'
        ? Promise.resolve({ code: 128, output: 'synthetic abort failure' })
        : undefined

    const result = await runPrReady(work, [], {}, { override: failAbort })

    expect(result.code).toBe(1)
    expect(result.out).toContain(
      'FAIL rebase: conflict in shared.txt; git rebase --abort failed (synthetic abort failure); ' +
        'a rebase is still in progress, abort it by hand',
    )
    expect(rebaseInProgress(work)).toBe(true)
  })

  it('aborts an in-progress rebase when a signal arrives mid-rebase', async () => {
    const work = conflictingRepo()
    let onSignal: (() => void) | undefined
    const trap: Trap = handler => ((onSignal = handler), () => (onSignal = undefined))
    let stateAfterSignal: boolean | undefined
    const signalMidRebase: Override = (line, args, cwd) => {
      if (line !== `git rebase ${BASE}`) return undefined
      return spawnRun('git', args, cwd).then(result => {
        onSignal?.()
        stateAfterSignal = rebaseInProgress(work)
        return result
      })
    }

    const result = await runPrReady(work, [], {}, { override: signalMidRebase, trap })

    expect(stateAfterSignal).toBe(false)
    expect(result.out).toContain('FAIL rebase: interrupted; rebase aborted')
    expect(onSignal).toBeUndefined()
  })

  it('installs SIGINT and SIGTERM handlers that clean up, exit with the signal code and come off after', () => {
    const emitter = new EventEmitter()
    const exits: number[] = []
    const cleanups: string[] = []
    const trap = signalTrap({
      once: (signal, listener) => emitter.once(signal, listener),
      off: (signal, listener) => emitter.off(signal, listener),
      exit: code => void exits.push(code),
    })

    const release = trap(() => cleanups.push('abort'))
    emitter.emit('SIGTERM')
    release()

    expect(cleanups).toEqual(['abort'])
    expect(exits).toEqual([143])
    expect(emitter.listenerCount('SIGINT') + emitter.listenerCount('SIGTERM')).toBe(0)
  })
})

describe('pr-ready on a branch that is already pushed', () => {
  const pushedBehindRepo = (): string => {
    const work = fixtureRepo({ 'package.json': pkg({}) }, { 'a.txt': '1\n' })
    git(work, 'push', '-q', '-u', 'origin', 'feature')
    advanceOrigin(work, { 'b.txt': '2\n' })
    return work
  }

  it('does not rebase a pushed branch that is behind, and leaves HEAD at the upstream', async () => {
    const work = pushedBehindRepo()
    const head = git(work, 'rev-parse', 'HEAD')

    const result = await runPrReady(work)

    expect(result.code).toBe(0)
    expect(result.out).toContain('ok rebase: behind origin/main, branch already pushed; not rebasing')
    expect(result.calls).not.toContain(`git rebase ${BASE}`)
    expect(git(work, 'rev-parse', 'HEAD')).toBe(head)
    expect(git(work, 'rev-parse', 'origin/feature')).toBe(head)
  })

  it('fails the rebase step under --strict', async () => {
    const work = pushedBehindRepo()

    const result = await runPrReady(work, [], { strict: true })

    expect(result.code).toBe(1)
    expect(result.out).toContain('FAIL rebase: behind origin/main, branch already pushed; not rebasing')
  })

  it('reports local unpushed commits and does not reset them', async () => {
    const work = pushedBehindRepo()
    commit(work, { 'c.txt': '3\n' }, 'local only')
    const head = git(work, 'rev-parse', 'HEAD')

    const result = await runPrReady(work)

    expect(result.out).toContain(
      'ok rebase: behind origin/main, branch already pushed; not rebasing; ' +
        '1 local commit(s) not pushed to origin/feature',
    )
    expect(git(work, 'rev-parse', 'HEAD')).toBe(head)
  })

  it('still rebases a branch that tracks only the default branch', async () => {
    const work = fixtureRepo({ 'package.json': pkg({}) }, { 'a.txt': '1\n' })
    git(work, 'branch', '--set-upstream-to=origin/main')
    advanceOrigin(work, { 'b.txt': '2\n' })

    const result = await runPrReady(work)

    expect(result.calls).toContain(`git rebase ${BASE}`)
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

  it('never lets npx download a changeset package that is not installed', async () => {
    const work = fixtureRepo(
      { 'package.json': pkg({}), '.changeset/config.json': '{}\n' },
      { 'a.txt': '1\n' },
    )

    const result = await runPrReady(work)

    const changeset = result.toolCalls.filter(call => call.includes('changeset'))
    expect(changeset).toEqual([`npx --no-install @changesets/cli status --since=${BASE}`])
  })

  it('turns an unexpected throw into a FAIL line and a non-zero exit', async () => {
    const work = fixtureRepo({ 'package.json': pkg({ scripts: { lint: 'x' } }) }, { 'a.txt': '1\n' })
    const throwOnLint: Override = line =>
      line === 'npm run lint' ? Promise.reject(new Error('synthetic spawn crash')) : undefined

    const result = await runPrReady(work, [], {}, { override: throwOnLint })

    expect(result.code).toBe(1)
    expect(result.out).toContain('FAIL checks: synthetic spawn crash')
    expect(result.out.at(-1)).toBe('PR-READY FAIL')
  })

  it('skips the fetch and rebase with --no-rebase', async () => {
    const work = fixtureRepo({ 'package.json': pkg({}) }, { 'a.txt': '1\n' })

    const result = await runPrReady(work, [], { rebase: false })

    expect(result.out).toContain('ok rebase: skipped (--no-rebase)')
    expect(result.calls.some(call => call.startsWith('git rebase') || call.startsWith('git fetch'))).toBe(
      false,
    )
  })

  it('uses the full remote ref, so a local branch named origin/main cannot shadow it', async () => {
    const work = fixtureRepo({ 'package.json': pkg({}) }, { 'a.txt': '1\n' })
    git(work, 'branch', 'origin/main', 'feature')
    advanceOrigin(work, { 'upstream.txt': 'u\n' })

    const result = await runPrReady(work)

    expect(result.code).toBe(0)
    expect(git(work, 'rev-parse', 'HEAD~1')).toBe(git(originOf(work), 'rev-parse', 'HEAD'))
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

/** What gh-write itself prints to stderr when it refuses these arguments; it never reaches gh. */
async function ghWriteRefusal(args: string[], termsFile: string): Promise<string> {
  const unreachable = () => Promise.reject(new Error('gh-write reached gh'))
  const result = await runGhWrite(args, scanDeps(termsFile), {
    now: Date.now,
    sleep: unreachable,
    runGh,
    coreRemaining: () => Promise.resolve(undefined),
    notice: () => undefined,
    lockDir: path.join(scratchDir(), 'lock'),
    stampPath: path.join(scratchDir(), 'stamp'),
    gapMs: 0,
  })
  expect(result.code).toBe(1)
  return result.stderr.toString().trimEnd()
}

describe('pr-ready scan', () => {
  const work = () => fixtureRepo({ 'package.json': pkg({}) }, { 'a.txt': '1\n' })
  const bodyFile = (text: string): string => {
    const file = path.join(scratchDir(), 'body.md')
    fs.writeFileSync(file, text)
    return file
  }

  it('fails on a finding in the body with the reason gh-write gives', async () => {
    const terms = syntheticTerms()
    const body = bodyFile(`Summary line.\nMentions ${TERM} here.\n`)
    const expected = await ghWriteRefusal(
      ['pr', 'create', '--title', 'Synthetic title', '--body-file', body],
      terms,
    )

    const result = await runPrReady(
      work(),
      [],
      { title: 'Synthetic title', bodyFile: body },
      { termsFile: terms },
    )

    expect(result.code).toBe(1)
    expect(result.out).toContain(`FAIL scan: ${expected}`)
    expect(expected).toContain('leak-guard: this text would publish private data')
    expect(result.out.join('\n')).not.toContain(TERM)
    expect(result.out.at(-1)).toBe('PR-READY FAIL')
  })

  it('fails on a finding in the title', async () => {
    const terms = syntheticTerms()
    const body = bodyFile('A clean body.\n')
    const expected = await ghWriteRefusal(
      ['pr', 'create', '--title', `Fix ${TERM}`, '--body-file', body],
      terms,
    )

    const result = await runPrReady(
      work(),
      [],
      { title: `Fix ${TERM}`, bodyFile: body },
      { termsFile: terms },
    )

    expect(result.code).toBe(1)
    expect(result.out).toContain(`FAIL scan: ${expected}`)
  })

  it('passes a clean title and body and claims no skipped scan', async () => {
    const dir = work()

    const result = await runPrReady(dir, [], {
      title: 'Synthetic title',
      bodyFile: bodyFile('A clean body.\n'),
    })

    expect(result.code).toBe(0)
    expect(result.out).toContain('ok scan')
    expect(result.out.at(-1)).toBe(`PR-READY OK ${git(dir, 'rev-parse', 'HEAD')}`)
  })

  it('reads a relative body file from the repo it checks', async () => {
    const dir = work()
    fs.writeFileSync(path.join(path.dirname(dir), 'body.md'), `Mentions ${TERM}.\n`)

    const result = await runPrReady(dir, [], { bodyFile: '../body.md' })

    expect(result.code).toBe(1)
    expect(result.out.some(line => line.startsWith('FAIL scan: leak-guard: this text would publish'))).toBe(
      true,
    )
  })

  it('prints the skipped line with no body file and says so on the OK line', async () => {
    const dir = work()

    const result = await runPrReady(dir)

    expect(result.code).toBe(0)
    expect(result.out).toContain('ok scan: skipped (no body file)')
    expect(result.out.at(-1)).toBe(
      `PR-READY OK ${git(dir, 'rev-parse', 'HEAD')} (scan skipped: no body file)`,
    )
  })

  it('fails when the term list is unreadable, as gh-write does', async () => {
    const unreadable = scratchDir()
    const body = bodyFile('A clean body.\n')
    const expected = await ghWriteRefusal(['pr', 'create', '--body-file', body], unreadable)

    const result = await runPrReady(work(), [], { bodyFile: body }, { termsFile: unreadable })

    expect(result.code).toBe(1)
    expect(result.out).toContain(`FAIL scan: ${expected}`)
  })

  it('fails when the term list is missing, as gh-write does', async () => {
    const missing = path.join(scratchDir(), 'absent')
    const body = bodyFile('A clean body.\n')
    const expected = await ghWriteRefusal(['pr', 'create', '--body-file', body], missing)

    const result = await runPrReady(work(), [], { bodyFile: body }, { termsFile: missing })

    expect(result.code).toBe(1)
    expect(result.out).toContain(`FAIL scan: ${expected}`)
  })
})

describe('pr-ready routes checks through basement-suite (CC-824)', () => {
  const REACHABLE = { AGENT_CHAT_NAME: 'agent-x' }
  const probeOk: Override = line => (line.startsWith('ssh -o') ? { code: 0, output: '' } : undefined)
  const pushHead = (work: string): void => {
    git(work, 'push', '-q', 'origin', 'feature')
  }
  const lintKind = () =>
    fixtureRepo({ 'package.json': pkg({ scripts: { lint: 'x', typecheck: 'x' } }) }, { 'a.ts': '1\n' })
  const sshCalls = (calls: string[]) => calls.filter(c => c.startsWith('ssh basement basement-suite'))
  const suite = (script: string) =>
    `ssh basement basement-suite origin feature --agent agent-x --run ${script}`

  it('runs each script on basement and nothing locally when the head is pushed', async () => {
    const work = lintKind()
    pushHead(work)
    const result = await runPrReady(work, [], {}, { override: probeOk, env: REACHABLE })

    expect(result.code).toBe(0)
    expect(sshCalls(result.calls)).toEqual([suite('lint'), suite('typecheck')])
    expect(result.calls.filter(c => c.startsWith('npm '))).toEqual([])
    expect(result.out).toContain('ok checks: basement lint exit 0, typecheck exit 0')
  })

  it('defers with the exact commands and runs nothing when the head is not pushed', async () => {
    const result = await runPrReady(lintKind(), [], {}, { override: probeOk, env: REACHABLE })

    expect(result.code).toBe(0)
    expect(result.out).toContain(
      `ok checks: deferred to basement after push: ${suite('lint')}; ${suite('typecheck')}`,
    )
    expect(sshCalls(result.calls)).toEqual([])
    expect(result.toolCalls.filter(c => !c.startsWith('ssh -o'))).toEqual([])
  })

  it('defers when the pushed ref is behind head', async () => {
    const work = lintKind()
    pushHead(work)
    commit(work, { 'b.ts': '2\n' }, 'more')
    const result = await runPrReady(work, [], {}, { override: probeOk, env: REACHABLE })

    expect(result.out.join('\n')).toContain('deferred to basement after push:')
  })

  it('falls back to local checks with a warning when the probe fails', async () => {
    const override: Override = line =>
      line.startsWith('ssh -o') ? { code: 255, output: 'no route' } : undefined
    const result = await runPrReady(lintKind(), [], {}, { override, env: REACHABLE })

    expect(result.code).toBe(0)
    expect(result.toolCalls.filter(c => c.startsWith('npm '))).toEqual(['npm run lint', 'npm run typecheck'])
    expect(result.errLines).toContain(
      'warning: basement unreachable (probe exit 255); running checks locally',
    )
  })

  it('fails as busy, not as a failed check, on exit 75', async () => {
    const work = lintKind()
    pushHead(work)
    const override: Override = (line, args) =>
      line === suite('lint') ? { code: 75, output: 'all slots busy' } : probeOk(line, args, work)
    const result = await runPrReady(work, [], {}, { override, env: REACHABLE })

    expect(result.code).toBe(1)
    expect(result.out.join('\n')).toContain(
      'FAIL checks: basement busy, retry in a few minutes (lint exit 75',
    )
  })

  it('reports a failing basement check by its command and exit code', async () => {
    const work = lintKind()
    pushHead(work)
    const override: Override = (line, args) =>
      line === suite('typecheck') ? { code: 1, output: 'tsc errors' } : probeOk(line, args, work)
    const result = await runPrReady(work, [], {}, { override, env: REACHABLE })

    expect(result.out.join('\n')).toContain(
      `FAIL checks: failed on basement: ${suite('typecheck')} (lint exit 0, typecheck exit 1)`,
    )
  })

  it('runs locally and never probes when the host is off', async () => {
    const result = await runPrReady(
      lintKind(),
      [],
      {},
      { override: probeOk, env: { AGENT_CHAT_BASEMENT_HOST: 'off' } },
    )

    expect(result.calls.filter(c => c.startsWith('ssh'))).toEqual([])
    expect(result.toolCalls).toEqual(['npm run lint', 'npm run typecheck'])
  })

  it('collapses per-member workspace commands into one run per script', async () => {
    const workspace = KINDS[2]!
    const work = fixtureRepo(workspace.base, workspace.feature)
    pushHead(work)
    const result = await runPrReady(work, [], {}, { override: probeOk, env: REACHABLE })

    const scripts = sshCalls(result.calls).map(c => c.split(' ').at(-1))
    expect(scripts).toEqual([...new Set(scripts)])
    expect(scripts).toContain('capabilities:check')
    expect(result.toolCalls.filter(c => c.startsWith('pnpm '))).toEqual([])
  })
})
