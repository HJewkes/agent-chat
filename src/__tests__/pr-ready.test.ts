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
 * The clone has a node_modules directory, as an installed tree does.
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
  fs.mkdirSync(path.join(work, 'node_modules'))
  return work
}

const advanceOrigin = (work: string, files: Record<string, string>): void =>
  commit(originOf(work), files, 'upstream')

const rebaseInProgress = (work: string): boolean =>
  ['rebase-merge', 'rebase-apply'].some(dir => fs.existsSync(path.join(work, '.git', dir)))

type Override = (line: string, args: string[], cwd: string) => Promise<RunResult> | RunResult | undefined

/** Real git; every package-manager call is recorded and answered from `failing`. */
function recorder(failing: string[], override?: Override) {
  const calls: string[] = []
  const run: Run = async (cmd, args, cwd, env) => {
    const line = [cmd, ...args].join(' ')
    calls.push(line)
    const overridden = override?.(line, args, cwd)
    if (overridden) return overridden
    if (cmd === 'git') return spawnRun(cmd, args, cwd, env)
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
  hostname?: string
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
    hostname: extra.hostname ?? 'workstation',
  })
  return {
    code,
    out,
    calls,
    errLines,
    toolCalls: calls.filter(call => !call.startsWith('git ') && !call.startsWith('gh pr list')),
  }
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
      `PR-READY OK exit=0 ${git(work, 'rev-parse', 'HEAD')} (scan skipped: no body file)`,
    ])
    expect(result.toolCalls).toEqual(kind.checks)
  })

  it('fails the checks step naming the failing command, and still runs the rest', async () => {
    const result = await runPrReady(repo(), [kind.failingCheck])

    expect(result.code).toBe(1)
    expect(result.out).toContain(`FAIL checks: failed: ${kind.failingCheck}`)
    expect(result.out.at(-1)).toBe('PR-READY FAIL exit=1')
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
    expect(result.out.at(-1)).toBe('PR-READY FAIL exit=1')
  })

  it('fails a dirty tree before any fetch, rebase or check', async () => {
    const work = repo()
    fs.writeFileSync(path.join(work, 'shared.txt'), 'edited\n')
    fs.writeFileSync(path.join(work, 'untracked.txt'), 'new\n')

    const result = await runPrReady(work)

    expect(result.code).toBe(1)
    expect(result.out).toEqual([
      'FAIL clean-tree: uncommitted changes in shared.txt, untracked.txt',
      'PR-READY FAIL exit=1',
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
    expect(result.out.at(-1)).toBe('PR-READY FAIL exit=1')
    expect(result.calls).toContain('git rebase --abort')
    expect(result.toolCalls).toEqual([])
    expect(rebaseInProgress(work)).toBe(false)
    expect(git(work, 'rev-parse', 'HEAD')).toBe(before)
  })
})

describe('pr-ready rebase identity', () => {
  it('keeps the branch identity on rewritten commits when the configured identity differs', async () => {
    const work = fixtureRepo({}, { 'f.txt': 'f\n' })
    const scout = { GIT_COMMITTER_NAME: 'scout', GIT_COMMITTER_EMAIL: 'scout@example.invalid' }
    for (const name of ['one', 'two']) {
      writeFiles(work, { [`${name}.txt`]: `${name}\n` })
      git(work, 'add', '-A')
      execFileSync('git', ['commit', '-q', '-m', name], {
        cwd: work,
        env: {
          ...process.env,
          ...scout,
          GIT_AUTHOR_NAME: 'scout',
          GIT_AUTHOR_EMAIL: 'scout@example.invalid',
        },
      })
    }
    advanceOrigin(work, { 'upstream.txt': 'u\n' })

    const result = await runPrReady(work)

    expect(result.code).toBe(0)
    expect(git(work, 'log', '--format=%cn %ce', 'refs/remotes/origin/main..HEAD')).toBe(
      'scout scout@example.invalid\nscout scout@example.invalid\nscout scout@example.invalid',
    )
  })

  it('uses the author identity when the HEAD committer was already tainted by an earlier rebase', async () => {
    const work = fixtureRepo({}, { 'f.txt': 'f\n' })
    writeFiles(work, { 'one.txt': 'one\n' })
    git(work, 'add', '-A')
    execFileSync('git', ['commit', '-q', '-m', 'one'], {
      cwd: work,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'scout',
        GIT_AUTHOR_EMAIL: 'scout@example.invalid',
        GIT_COMMITTER_NAME: 'stale',
        GIT_COMMITTER_EMAIL: 'stale@example.invalid',
      },
    })
    advanceOrigin(work, { 'upstream.txt': 'u\n' })

    const result = await runPrReady(work)

    expect(result.code).toBe(0)
    expect(git(work, 'log', '--format=%cn %ce', 'refs/remotes/origin/main..HEAD')).toBe(
      'scout scout@example.invalid\nscout scout@example.invalid',
    )
  })

  it('warns and keeps the configured committer when HEAD identity cannot be read', async () => {
    const work = fixtureRepo({}, { 'f.txt': 'f\n' })
    advanceOrigin(work, { 'upstream.txt': 'u\n' })
    const override: Override = line =>
      line.startsWith('git log -1') ? { code: 1, output: 'synthetic failure' } : undefined

    const result = await runPrReady(work, [], {}, { override })

    expect(result.code).toBe(0)
    expect(result.errLines.join('\n')).toContain("could not read HEAD's identity")
    expect(git(work, 'log', '-1', '--format=%ce')).toBe('fixture@example.invalid')
  })
})

describe('pr-ready in a fresh worktree with no node_modules', () => {
  const PNPM_INSTALL = 'pnpm install --frozen-lockfile --ignore-scripts'
  const NPM_INSTALL = 'npm ci --ignore-scripts'
  const [npmKind, pnpmKind] = KINDS as [Kind, Kind]
  const freshRepo = (kind: Kind, extra: Record<string, string> = {}): string => {
    const work = fixtureRepo({ ...kind.base, ...extra }, kind.feature)
    fs.rmSync(path.join(work, 'node_modules'), { recursive: true })
    return work
  }

  it('installs with pnpm after the rebase and before any check', async () => {
    const result = await runPrReady(freshRepo(pnpmKind))

    expect(result.code).toBe(0)
    expect(result.out).toContain(`ok deps: installed with ${PNPM_INSTALL}`)
    expect(result.out.indexOf(`ok deps: installed with ${PNPM_INSTALL}`)).toBe(
      result.out.indexOf('ok rebase') + 1,
    )
    expect(result.toolCalls).toEqual([PNPM_INSTALL, ...pnpmKind.checks])
  })

  it('installs with npm ci in an npm repo', async () => {
    const result = await runPrReady(freshRepo(npmKind))

    expect(result.code).toBe(0)
    expect(result.out).toContain(`ok deps: installed with ${NPM_INSTALL}`)
    expect(result.toolCalls).toEqual([NPM_INSTALL, ...npmKind.checks])
  })

  it('names the install command and stops before the checks when the install fails', async () => {
    const work = freshRepo(pnpmKind, { '.changeset/config.json': '{}\n' })
    const notFound: Override = line =>
      line === pnpmKind.changeset ? { code: 1, output: 'Command changeset not found' } : undefined

    const result = await runPrReady(work, [PNPM_INSTALL], {}, { override: notFound })

    expect(result.code).toBe(1)
    expect(result.out.slice(-2)).toEqual([
      `FAIL deps: ${PNPM_INSTALL} failed (synthetic failure: ${PNPM_INSTALL}); ` +
        'run it in this worktree, then re-run pr-ready',
      'PR-READY FAIL exit=1',
    ])
    expect(result.out.join('\n')).not.toContain('Command changeset not found')
    expect(result.toolCalls).toEqual([PNPM_INSTALL])
  })

  it('installs nothing and prints no deps line when node_modules is present', async () => {
    const result = await runPrReady(fixtureRepo(pnpmKind.base, pnpmKind.feature))

    expect(result.out.some(line => line.includes('deps'))).toBe(false)
    expect(result.toolCalls).not.toContain(PNPM_INSTALL)
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
    let onSignal: ((exitCode: number) => void) | undefined
    const trap: Trap = handler => ((onSignal = handler), () => (onSignal = undefined))
    let stateAfterSignal: boolean | undefined
    const signalMidRebase: Override = (line, args, cwd) => {
      if (line !== `git rebase ${BASE}`) return undefined
      return spawnRun('git', args, cwd).then(result => {
        onSignal?.(130)
        stateAfterSignal = rebaseInProgress(work)
        return result
      })
    }

    const result = await runPrReady(work, [], {}, { override: signalMidRebase, trap })

    expect(stateAfterSignal).toBe(false)
    expect(result.out).toContain('FAIL rebase: interrupted; rebase aborted')
    expect(result.out).toContain('PR-READY FAIL exit=130')
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

    const release = trap(code => cleanups.push(`abort ${code}`))
    emitter.emit('SIGTERM')
    release()

    expect(cleanups).toEqual(['abort 143'])
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

  it('does not rebase an unpushed-looking branch that has an open PR, and suggests a merge', async () => {
    const work = fixtureRepo({ 'package.json': pkg({}) }, { 'a.txt': '1\n' })
    advanceOrigin(work, { 'b.txt': '2\n' })
    const head = git(work, 'rev-parse', 'HEAD')
    const openPr: Override = line =>
      line.startsWith('gh pr list --head feature') ? { code: 0, output: '[{"number":7}]' } : undefined

    const result = await runPrReady(work, [], {}, { override: openPr })

    expect(result.out).toContain(
      'ok rebase: behind origin/main, branch already pushed; not rebasing; open PR: merge origin/main instead',
    )
    expect(result.calls).not.toContain(`git rebase ${BASE}`)
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

describe('pr-ready on a branch stacked on another agent branch (CC-1281)', () => {
  const PARENT = 'refs/remotes/origin/agent-chat/parent'
  const answering =
    (head: string, output: string): Override =>
    line =>
      line.startsWith(`gh pr list --head ${head} `) ? { code: 0, output } : undefined

  /** feature is cut from origin/agent-chat/parent, then main moves on with m.txt. */
  const stackedRepo = (): string => {
    const work = fixtureRepo({ 'package.json': pkg({}) }, { 'discarded.txt': 'd\n' })
    const origin = originOf(work)
    git(origin, 'checkout', '-q', '-b', 'agent-chat/parent')
    commit(origin, { 'p.txt': 'p\n' }, 'parent')
    git(origin, 'checkout', '-q', 'main')
    git(work, 'fetch', '-q', 'origin')
    git(work, 'checkout', '-q', '--no-track', '-B', 'feature', 'origin/agent-chat/parent')
    commit(work, { 'f.txt': 'f\n' }, 'feature')
    advanceOrigin(work, { 'm.txt': 'm\n' })
    return work
  }
  const tree = (work: string): string[] => git(work, 'ls-tree', '--name-only', 'HEAD').split('\n')

  const noMainCommit = (work: string): void => {
    expect(tree(work)).toEqual(expect.arrayContaining(['f.txt', 'p.txt']))
    expect(tree(work)).not.toContain('m.txt')
  }

  it('infers the parent from its open PR and rebases onto it with no main commit', async () => {
    const work = stackedRepo()

    const result = await runPrReady(
      work,
      [],
      {},
      { override: answering('agent-chat/parent', '[{"number":5}]') },
    )

    expect(result.code).toBe(0)
    expect(result.out).toContain(`ok base: ${PARENT} (stacked on origin/agent-chat/parent (PR #5))`)
    expect(result.calls).toContain(`git rebase ${PARENT}`)
    expect(result.calls).not.toContain(`git rebase ${BASE}`)
    noMainCommit(work)
  })

  it("judges a branch with its own open PR against that PR's base, not main", async () => {
    const work = stackedRepo()
    const openPr = answering('feature', '[{"number":9,"baseRefName":"agent-chat/parent"}]')

    const result = await runPrReady(work, [], {}, { override: openPr })

    expect(result.code).toBe(0)
    expect(result.out).toContain(`ok base: ${PARENT} (PR #9 base)`)
    expect(result.out).toContain('ok rebase: not behind origin/agent-chat/parent')
    noMainCommit(work)
  })

  it('fails the base step without rebasing when the parent has no open PR', async () => {
    const work = stackedRepo()
    const head = git(work, 'rev-parse', 'HEAD')

    const result = await runPrReady(work, [], {}, { override: answering('agent-chat/parent', '[]') })

    expect(result.code).toBe(1)
    expect(result.out).toContain(
      'FAIL base: HEAD contains commits of origin/agent-chat/parent not on origin/main; cannot tell the base: ' +
        'record it with git config branch.feature.agent-chat-base <name> (use main if the parent merged)',
    )
    expect(result.calls.filter(call => call.startsWith('git rebase'))).toEqual([])
    expect(git(work, 'rev-parse', 'HEAD')).toBe(head)
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
    expect(result.out.at(-1)).toBe('PR-READY FAIL exit=1')
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
      'PR-READY FAIL exit=1',
    ])
  })
})

describe('pr-ready privacy guard', () => {
  const PRIVACY = 'npx --no-install vitest run src/__tests__/fixtures-privacy.test.ts'
  // Synthetic names only: fixtures-privacy scans this file too.
  const leakOutput =
    'AssertionError: privacy leak: planted.test.ts: seat-zz-leak: expected [] to deeply equal []'
  const agentChatRepo = () =>
    fixtureRepo(
      {
        'package.json': pkg({ scripts: { lint: 'x' } }),
        'src/__tests__/fixtures-privacy.test.ts': 'synthetic\n',
      },
      { 'a.txt': '1\n' },
    )

  it('fails naming the leaked file and name when the privacy test fails', async () => {
    const leak: Override = line => (line === PRIVACY ? { code: 1, output: leakOutput } : undefined)

    const result = await runPrReady(agentChatRepo(), [], {}, { override: leak })

    expect(result.code).toBe(1)
    expect(result.out).toContain('FAIL privacy: privacy leak: planted.test.ts: seat-zz-leak')
    expect(result.out.at(-1)).toBe('PR-READY FAIL exit=1')
    expect(result.toolCalls).toEqual(['npm run lint', PRIVACY])
  })

  it('prints ok privacy after the checks and exits 0 when the privacy test passes', async () => {
    const result = await runPrReady(agentChatRepo())

    expect(result.code).toBe(0)
    expect(result.out.slice(3, 5)).toEqual(['ok checks', 'ok privacy'])
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
    expect(result.out.at(-1)).toBe('PR-READY FAIL exit=1')
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
    expect(result.out.at(-1)).toBe(`PR-READY OK exit=0 ${git(dir, 'rev-parse', 'HEAD')}`)
  })

  it('passes the clean-tree check when the only untracked path is the body file', async () => {
    const dir = work()
    fs.writeFileSync(path.join(dir, 'pr-body.md'), 'A clean body.\n')

    const result = await runPrReady(dir, [], { bodyFile: path.join(fs.realpathSync(dir), 'pr-body.md') })

    expect(result.out).toContain('ok clean-tree')
  })

  it('still fails the clean-tree check on another untracked file beside the body file', async () => {
    const dir = work()
    fs.writeFileSync(path.join(dir, 'pr-body.md'), 'A clean body.\n')
    fs.writeFileSync(path.join(dir, 'stray.txt'), 'x\n')

    const result = await runPrReady(dir, [], { bodyFile: 'pr-body.md' })

    expect(result.code).toBe(1)
    expect(result.out).toContain('FAIL clean-tree: uncommitted changes in stray.txt')
  })

  it('passes the clean-tree check with an untracked node_modules symlink into another checkout', async () => {
    const dir = work()
    fs.rmSync(path.join(dir, 'node_modules'), { recursive: true })
    fs.symlinkSync(scratchDir(), path.join(dir, 'node_modules'))

    const result = await runPrReady(dir)

    expect(result.out).toContain('ok clean-tree')
    expect(result.out.at(-1)).toBe(
      `PR-READY OK exit=0 ${git(dir, 'rev-parse', 'HEAD')} (scan skipped: no body file)`,
    )
  })

  it('passes the clean-tree check with an untracked nested node_modules directory', async () => {
    const dir = work()
    commit(dir, { 'packages/x/index.ts': '1\n' }, 'package')
    writeFiles(dir, { 'packages/x/node_modules/dep/index.js': '1\n' })

    const result = await runPrReady(dir)

    expect(result.out).toContain('ok clean-tree')
  })

  it('still fails the clean-tree check on another untracked file beside a node_modules symlink', async () => {
    const dir = work()
    fs.rmSync(path.join(dir, 'node_modules'), { recursive: true })
    fs.symlinkSync(scratchDir(), path.join(dir, 'node_modules'))
    fs.writeFileSync(path.join(dir, 'other.txt'), 'x\n')

    const result = await runPrReady(dir)

    expect(result.code).toBe(1)
    expect(result.out).toContain('FAIL clean-tree: uncommitted changes in other.txt')
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
      `PR-READY OK exit=0 ${git(dir, 'rev-parse', 'HEAD')} (scan skipped: no body file)`,
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
  /** Points origin at a symlink named `repo`, since basement-suite only serves the repos it lists. */
  const servedAs = (work: string, repo: string): string => {
    const named = path.join(path.dirname(work), repo)
    fs.symlinkSync(originOf(work), named)
    git(work, 'remote', 'set-url', 'origin', named)
    return work
  }
  const lintFixture = () =>
    fixtureRepo({ 'package.json': pkg({ scripts: { lint: 'x', typecheck: 'x' } }) }, { 'a.ts': '1\n' })
  const lintKind = () => servedAs(lintFixture(), 'agent-chat')
  const sshCalls = (calls: string[]) => calls.filter(c => c.startsWith('ssh basement basement-suite'))
  const suite = (script: string) =>
    `ssh basement basement-suite agent-chat feature --agent agent-x --run ${script}`
  const pushedAnswering = async (script: string, answer: RunResult) => {
    const work = lintKind()
    pushHead(work)
    const override: Override = (line, args) => (line === suite(script) ? answer : probeOk(line, args, work))
    return runPrReady(work, [], {}, { override, env: REACHABLE })
  }

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

  it('prints one line per deferred script and ends on the exit line (CC-837)', async () => {
    const work = lintKind()
    const result = await runPrReady(work, [], {}, { override: probeOk, env: REACHABLE })

    expect(result.out.filter(line => line.startsWith('deferred '))).toEqual([
      `deferred lint: ${suite('lint')}; run id: none (not started)`,
      `deferred typecheck: ${suite('typecheck')}; run id: none (not started)`,
    ])
    expect(result.out.at(-1)).toBe(
      `PR-READY OK exit=0 ${git(work, 'rev-parse', 'HEAD')} (scan skipped: no body file)`,
    )
  })

  it('names each basement run by the log path basement-suite reports (CC-837)', async () => {
    const summary = 'repo=agent-chat script=lint slot=1 log=basement:/runs/agent-x/agent-chat-1.log\nexit=0'
    const result = await pushedAnswering('lint', { code: 0, output: summary })

    expect(result.out.filter(line => line.startsWith('basement '))).toEqual([
      'basement lint exit 0 run basement:/runs/agent-x/agent-chat-1.log',
      'basement typecheck exit 0 run run id: unknown',
    ])
  })

  it('ends a failed basement check on the exit line (CC-837)', async () => {
    const result = await pushedAnswering('typecheck', { code: 1, output: 'tsc errors' })

    expect(result.code).toBe(1)
    expect(result.out).toContain('basement typecheck exit 1 run run id: unknown')
    expect(result.out.at(-1)).toBe('PR-READY FAIL exit=1')
  })

  it('names the branch origin holds when the upstream differs from the local branch', async () => {
    const work = lintKind()
    git(work, 'push', '-q', '-u', 'origin', 'feature:pr-head')
    const result = await runPrReady(work, [], {}, { override: probeOk, env: REACHABLE })

    expect(sshCalls(result.calls)).toEqual([
      'ssh basement basement-suite agent-chat pr-head --agent agent-x --run lint',
      'ssh basement basement-suite agent-chat pr-head --agent agent-x --run typecheck',
    ])
  })

  it('defers when only a non-origin remote holds the head, since basement fetches from origin', async () => {
    const work = lintKind()
    git(work, 'remote', 'add', 'fork', git(work, 'remote', 'get-url', 'origin').trim())
    git(work, 'push', '-q', '-u', 'fork', 'feature:fork-head')
    const result = await runPrReady(work, [], {}, { override: probeOk, env: REACHABLE })

    expect(sshCalls(result.calls)).toEqual([])
    expect(result.out.join('\n')).toContain('deferred to basement after push:')
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

  describe('on basement itself (CC-909)', () => {
    const direct = (script: string) => `basement-suite agent-chat feature --agent agent-x --run ${script}`
    const onHost = (hostname: string) => ({ override: probeOk, env: REACHABLE, hostname })

    it('calls basement-suite directly and never ssh when the hostname is the basement host', async () => {
      const work = lintKind()
      pushHead(work)
      const result = await runPrReady(work, [], {}, onHost('basement'))

      expect(result.code).toBe(0)
      expect(result.toolCalls).toEqual([direct('lint'), direct('typecheck')])
      expect(result.out).toContain('ok checks: basement lint exit 0, typecheck exit 0')
    })

    it('matches a fully qualified hostname by its first label', async () => {
      const work = lintKind()
      pushHead(work)
      const result = await runPrReady(work, [], {}, onHost('Basement.lan'))

      expect(result.toolCalls).toEqual([direct('lint'), direct('typecheck')])
    })

    it('defers with direct commands when the head is not pushed', async () => {
      const result = await runPrReady(lintKind(), [], {}, onHost('basement'))

      expect(result.out).toContain(
        `ok checks: deferred to basement after push: ${direct('lint')}; ${direct('typecheck')}`,
      )
      expect(result.toolCalls).toEqual([])
    })

    it('keeps the ssh probe and call on any other host', async () => {
      const work = lintKind()
      pushHead(work)
      const result = await runPrReady(work, [], {}, onHost('workstation'))

      expect(result.toolCalls).toEqual([
        'ssh -o BatchMode=yes -o ConnectTimeout=3 basement true',
        suite('lint'),
        suite('typecheck'),
      ])
    })
  })

  it('collapses per-member workspace commands into one run per script', async () => {
    const workspace = KINDS[2]!
    const work = servedAs(fixtureRepo(workspace.base, workspace.feature), 'titan-platform')
    pushHead(work)
    const result = await runPrReady(work, [], {}, { override: probeOk, env: REACHABLE })

    const scripts = sshCalls(result.calls).map(c => c.split(' ').at(-1))
    expect(scripts).toEqual([...new Set(scripts)])
    expect(scripts).toContain('capabilities:check')
    expect(result.toolCalls.filter(c => c.startsWith('pnpm '))).toEqual([])
  })

  it('runs locally without probing in a repo basement-suite does not serve', async () => {
    const work = servedAs(lintFixture(), 'relay')
    pushHead(work)
    const result = await runPrReady(work, [], {}, { override: probeOk, env: REACHABLE })

    expect(result.calls.filter(c => c.startsWith('ssh'))).toEqual([])
    expect(result.toolCalls).toEqual(['npm run lint', 'npm run typecheck'])
    expect(result.errLines).toContain(
      "warning: basement-suite does not serve repo 'relay'; running checks locally",
    )
  })

  it('runs locally when royal_road_player would be asked for a script other than test', async () => {
    const work = servedAs(lintFixture(), 'royal_road_player')
    pushHead(work)
    const result = await runPrReady(work, [], {}, { override: probeOk, env: REACHABLE })

    expect(sshCalls(result.calls)).toEqual([])
    expect(result.errLines).toContain(
      "warning: basement-suite cannot run script 'lint' in royal_road_player; running checks locally",
    )
  })

  it('runs locally when the agent name breaks basement-suite rules', async () => {
    const work = lintKind()
    pushHead(work)
    const env = { AGENT_CHAT_NAME: 'agent x;rm' }
    const result = await runPrReady(work, [], {}, { override: probeOk, env })

    expect(sshCalls(result.calls)).toEqual([])
    expect(result.errLines).toContain(
      "warning: basement-suite refuses agent name 'agent x;rm'; running checks locally",
    )
  })

  it('reports a setup failure on exit 69 as basement trouble and stops there', async () => {
    const result = await pushedAnswering('lint', { code: 69, output: 'install failed' })

    expect(sshCalls(result.calls)).toEqual([suite('lint')])
    expect(result.code).toBe(1)
    expect(result.out.join('\n')).toContain(
      'FAIL checks: basement could not set up the run (fetch, install or build failed) (lint exit 69)',
    )
  })

  it('reports a usage refusal on exit 64 as basement trouble, not a failed check', async () => {
    const result = await pushedAnswering('lint', { code: 64, output: 'usage' })

    expect(result.out.join('\n')).toContain(
      'FAIL checks: basement-suite refused the arguments (lint exit 64)',
    )
    expect(result.out.join('\n')).not.toContain('failed on basement')
  })
})
