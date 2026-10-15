import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prReady, spawnRun, type Run, type RunResult } from '../cli/verbs/pr-ready.js'
import { needsTypedLint, typedLintStep } from '../cli/verbs/pr-ready-typed-lint.js'

const BASE = 'refs/remotes/origin/main'
const UNSAFE_ASSERTION =
  'packages/a/src/x.ts\n  3:9  error  Unsafe type assertion: type `Foo` is more narrow than the original type  @typescript-eslint/no-unsafe-type-assertion'
const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function commit(dir: string, files: Record<string, string>, message: string): void {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), content)
  }
  git(dir, 'add', '-A')
  git(dir, '-c', 'user.name=Fixture', '-c', 'user.email=f@example.invalid', 'commit', '-q', '-m', message)
}

const pkg = (scripts: Record<string, string>): string => JSON.stringify({ name: 'root', scripts })

/** A repo whose base commit sits at origin/main and whose HEAD adds `feature`. */
function repo(base: Record<string, string>, feature: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-ready-typed-lint-'))
  tmpDirs.push(dir)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'commit.gpgsign', 'false')
  commit(dir, base, 'base')
  git(dir, 'update-ref', BASE, 'HEAD')
  commit(dir, feature, 'feature')
  return dir
}

const PNPM_ROOT = { 'package.json': pkg({ build: 'x', 'lint:types': 'x' }), 'pnpm-lock.yaml': '' }
const TS_CHANGE = { 'packages/a/src/x.ts': 'export const x = 1\n' }

/** Real git; every package-manager call is recorded and answered from `answers`, else exit 0. */
function recorder(answers: Record<string, RunResult> = {}, other?: (line: string) => RunResult | undefined) {
  const calls: string[] = []
  const run: Run = async (cmd, args, cwd) => {
    const line = [cmd, ...args].join(' ')
    if (cmd === 'git') return spawnRun(cmd, args, cwd)
    calls.push(line)
    return answers[line] ?? other?.(line) ?? { code: 0, output: '' }
  }
  return { run, calls }
}

async function step(dir: string, answers: Record<string, RunResult> = {}) {
  const { run, calls } = recorder(answers)
  const errLines: string[] = []
  const outcome = await typedLintStep(run, dir, BASE, line => errLines.push(line))
  return { outcome, calls, errLines }
}

describe('typed-lint step (CC-1296)', () => {
  it('a no-unsafe-type-assertion error from lint:types fails the step after the build', async () => {
    const dir = repo(PNPM_ROOT, TS_CHANGE)

    const result = await step(dir, { 'pnpm run lint:types': { code: 1, output: UNSAFE_ASSERTION } })

    expect(result.outcome).toEqual({ ok: false, reason: 'failed: pnpm run lint:types' })
    expect(result.errLines.join('\n')).toContain('@typescript-eslint/no-unsafe-type-assertion')
    expect(result.calls).toEqual(['pnpm run build', 'pnpm run lint:types'])
  })

  it('a failed build skips lint:types and names the build', async () => {
    const dir = repo(PNPM_ROOT, TS_CHANGE)

    const result = await step(dir, { 'pnpm run build': { code: 2, output: 'tsc failed' } })

    expect(result.outcome).toEqual({ ok: false, reason: 'failed: pnpm run build' })
    expect(result.calls).toEqual(['pnpm run build'])
  })

  it('does nothing in a repo without a root lint:types script', async () => {
    const dir = repo({ 'package.json': pkg({ build: 'x' }), 'pnpm-lock.yaml': '' }, TS_CHANGE)

    const result = await step(dir)

    expect(result.outcome).toEqual({ ok: true, reason: 'no lint:types script' })
    expect(result.calls).toEqual([])
  })

  it('leaves every check to a root pr-ready script', async () => {
    const dir = repo({ 'package.json': pkg({ 'pr-ready': 'x', 'lint:types': 'x' }) }, TS_CHANGE)

    const result = await step(dir)

    expect(result.outcome.ok).toBe(true)
    expect(result.calls).toEqual([])
  })

  it('skips a docs-only diff', async () => {
    const dir = repo(PNPM_ROOT, { 'site/x.md': '# doc\n' })

    const result = await step(dir)

    expect(result.outcome).toEqual({ ok: true, reason: 'skipped (no TypeScript or config change)' })
    expect(result.calls).toEqual([])
  })

  it('uses npm in a repo with no pnpm lockfile', async () => {
    const dir = repo(
      { 'package.json': pkg({ build: 'x', 'lint:types': 'x' }), 'package-lock.json': '{}' },
      TS_CHANGE,
    )

    const result = await step(dir)

    expect(result.outcome).toEqual({ ok: true })
    expect(result.calls).toEqual(['npm run build', 'npm run lint:types'])
  })

  it.each([
    ['a.tsx', true],
    ['b.mts', true],
    ['tsconfig.base.json', true],
    ['eslint.typed.config.js', true],
    ['pkg/package.json', true],
    ['README.md', false],
    ['x.css', false],
  ])('needsTypedLint(%s) is %s', (file, expected) => {
    expect(needsTypedLint([file])).toBe(expected)
  })
})

describe('pr-ready runs typed lint locally even when basement would defer (CC-1296)', () => {
  /** An origin clone whose origin is named agent-chat, a repo basement-suite serves; HEAD stays unpushed. */
  function unpushedClone(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-ready-typed-lint-'))
    tmpDirs.push(root)
    const origin = path.join(root, 'agent-chat')
    const work = path.join(root, 'work')
    git(root, 'init', '-q', '-b', 'main', origin)
    commit(origin, { 'package.json': pkg({ typecheck: 'x', build: 'x', 'lint:types': 'x' }) }, 'base')
    git(root, 'clone', '-q', origin, work)
    git(work, 'checkout', '-q', '-b', 'feature')
    commit(work, TS_CHANGE, 'feature')
    fs.mkdirSync(path.join(work, 'node_modules'))
    return work
  }

  it('fails the run on a lint:types error while the checks step defers', async () => {
    const work = unpushedClone()
    const { run, calls } = recorder({ 'npm run lint:types': { code: 1, output: UNSAFE_ASSERTION } })
    const out: string[] = []

    const code = await prReady(
      { rebase: false },
      {
        run,
        cwd: work,
        out: line => out.push(line),
        err: () => {},
        trap: () => () => {},
        termsFile: path.join(work, 'no-terms'),
        env: { AGENT_CHAT_BASEMENT_HOST: 'basement', AGENT_CHAT_NAME: 'agent-x' },
        hostname: 'basement',
      },
    )

    expect(code).toBe(1)
    expect(out.some(line => line.startsWith('ok checks: deferred to basement after push:'))).toBe(true)
    expect(out).toContain('FAIL typed-lint: failed: npm run lint:types')
    expect(out.at(-1)).toBe('PR-READY FAIL exit=1')
    expect(calls).toEqual(expect.arrayContaining(['npm run build', 'npm run lint:types']))
  })
})
