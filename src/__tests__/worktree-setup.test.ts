import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorktreeStrategy, reattachWorktree } from '../agents/isolation/worktree.js'
import {
  runSetupCommand,
  SETUP_FILE,
  type SetupResult,
  type SetupRunner,
} from '../agents/isolation/worktree-setup.js'
import type { IsolationContext } from '../agents/isolation/index.js'

const tmpdirs: string[] = []

afterEach(() => {
  while (tmpdirs.length > 0) fs.rmSync(tmpdirs.pop() ?? '', { recursive: true, force: true })
})

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

const tmpdir = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  tmpdirs.push(dir)
  return dir
}

/** A synthetic repository with one commit, declaring `setup` when given. */
function makeRepo(setup?: object): string {
  const dir = tmpdir('wt-setup-')
  git(['init', '-b', 'main'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  git(['config', 'user.name', 'Test'], dir)
  git(['config', 'commit.gpgsign', 'false'], dir)
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n')
  if (setup !== undefined) {
    fs.mkdirSync(path.join(dir, '.agent-chat'))
    fs.writeFileSync(path.join(dir, SETUP_FILE), JSON.stringify({ setup }))
  }
  git(['add', '.'], dir)
  git(['commit', '-m', 'seed'], dir)
  return dir
}

const ctxFor = (cwd: string, agentName = 'alice'): IsolationContext => ({
  agentId: `ag-${agentName}`,
  agentName,
  baseCwd: cwd,
})

interface Recorded {
  runner: SetupRunner
  calls: Array<{ command: readonly string[]; cwd: string; treeExisted: boolean }>
}

const recording = (result: SetupResult = { exitCode: 0, timedOut: false, output: '' }): Recorded => {
  const calls: Recorded['calls'] = []
  const runner: SetupRunner = async (command, cwd) => {
    calls.push({ command, cwd, treeExisted: fs.existsSync(path.join(cwd, 'README.md')) })
    return result
  }
  return { runner, calls }
}

const setupWarnings = (warnings: readonly string[] | undefined): string[] =>
  (warnings ?? []).filter(w => w.includes('setup'))

describe('worktree setup on allocate', () => {
  it('runs the declared step inside the new worktree before allocation returns', async () => {
    const repo = makeRepo({ command: ['npm', 'ci'] })
    let finish: (r: SetupResult) => void = () => undefined
    const calls: string[] = []
    const runner: SetupRunner = (command, cwd) => {
      calls.push(`${command.join(' ')} @ ${cwd}`)
      return new Promise(resolve => (finish = resolve))
    }
    let settled = false
    const allocating = createWorktreeStrategy({ runSetup: runner })
      .allocate(ctxFor(repo))
      .finally(() => (settled = true))

    await expect.poll(() => calls.length).toBe(1)
    expect(settled).toBe(false)
    finish({ exitCode: 0, timedOut: false, output: '' })
    const alloc = await allocating

    expect(calls).toEqual([`npm ci @ ${alloc.cwd}`])
    expect(setupWarnings(alloc.warnings)).toEqual([])
  })

  it('runs nothing when the repository declares no step', async () => {
    const repo = makeRepo()
    const { runner, calls } = recording()

    const alloc = await createWorktreeStrategy({ runSetup: runner }).allocate(ctxFor(repo))

    expect(calls).toEqual([])
    expect(setupWarnings(alloc.warnings)).toEqual([])
  })

  it('turns a failing step into a warning naming it and its exit, and still allocates', async () => {
    const repo = makeRepo({ command: ['npm', 'ci'] })
    const { runner } = recording({ exitCode: 1, timedOut: false, output: 'npm ERR! lockfile out of sync\n' })

    const alloc = await createWorktreeStrategy({ runSetup: runner }).allocate(ctxFor(repo))

    expect(fs.existsSync(alloc.cwd)).toBe(true)
    expect(setupWarnings(alloc.warnings)).toEqual([
      expect.stringMatching(/`npm ci` exited with code 1 \(npm ERR! lockfile out of sync\)/),
    ])
  })

  it('reports a timed-out step as killed', async () => {
    const repo = makeRepo({ command: ['npm', 'ci'], timeoutMs: 50 })
    const { runner } = recording({ exitCode: null, timedOut: true, output: '' })

    const alloc = await createWorktreeStrategy({ runSetup: runner }).allocate(ctxFor(repo))

    expect(setupWarnings(alloc.warnings)).toEqual([
      expect.stringContaining('`npm ci` timed out after 50ms and was killed'),
    ])
  })

  it('warns and runs nothing when the declaration is malformed', async () => {
    const repo = makeRepo({ command: 'npm ci' })
    const { runner, calls } = recording()

    const alloc = await createWorktreeStrategy({ runSetup: runner }).allocate(ctxFor(repo))

    expect(calls).toEqual([])
    expect(setupWarnings(alloc.warnings)).toEqual([expect.stringContaining('setup.command must be')])
  })
})

describe('worktree setup on resume re-creation', () => {
  it('runs the declared step in the re-created worktree', async () => {
    const repo = makeRepo({ command: ['npm', 'ci'] })
    const first = await createWorktreeStrategy({ runSetup: recording().runner }).allocate(ctxFor(repo))
    git(['worktree', 'remove', '--force', first.cwd], repo)
    const { runner, calls } = recording()

    const record = { gitRoot: repo, worktree: first.cwd, branch: first.ref?.branch ?? '' }
    const again = await reattachWorktree(record, { runSetup: runner })

    expect(again.cwd).toBe(first.cwd)
    expect(calls).toEqual([{ command: ['npm', 'ci'], cwd: first.cwd, treeExisted: true }])
  })
})

describe('the default setup runner', () => {
  it('reports the exit code and the output', async () => {
    const dir = tmpdir('wt-run-')
    const result = await runSetupCommand(['sh', '-c', 'echo installing; exit 3'], dir, 5_000)
    expect(result).toEqual({ exitCode: 3, timedOut: false, output: 'installing\n' })
  })

  it('kills a step that outlives its timeout', async () => {
    const dir = tmpdir('wt-run-')
    const started = Date.now()
    const result = await runSetupCommand(['sh', '-c', 'sleep 30'], dir, 200)
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  it('reports a command that cannot start', async () => {
    const dir = tmpdir('wt-run-')
    const result = await runSetupCommand(['definitely-not-a-command-cc313'], dir, 5_000)
    expect(result.exitCode).toBeNull()
    expect(result.output).toContain('ENOENT')
  })
})

const EGRESS_HOOK = path.resolve('node_modules/@titan-design/egress-scan/hooks/pre-push')

/** Stands in for the scanner: records that the hook reached it, then allows the push. */
const STUB_SCANNER =
  'mkdir -p node_modules/.bin && printf \'#!/bin/sh\\ntouch "$(git rev-parse --show-toplevel)/scanner-ran"\\n\' > node_modules/.bin/titan-egress-scan && chmod +x node_modules/.bin/titan-egress-scan'

/** A synthetic repo with a bare origin and the real egress-scan pre-push hook in its shared hooks dir. */
function makeHookedRepo(setup?: object): string {
  const repo = makeRepo(setup)
  const origin = tmpdir('wt-origin-')
  git(['init', '--bare', '-b', 'main'], origin)
  git(['remote', 'add', 'origin', origin], repo)
  git(['push', '-q', 'origin', 'main'], repo)
  const hook = path.join(repo, '.git', 'hooks', 'pre-push')
  fs.copyFileSync(EGRESS_HOOK, hook)
  fs.chmodSync(hook, 0o755)
  return repo
}

const pushFrom = (cwd: string): { status: number | null; stderr: string } => {
  fs.writeFileSync(path.join(cwd, 'work.txt'), 'work\n')
  git(['add', 'work.txt'], cwd)
  git(['commit', '-m', 'work'], cwd)
  const pushed = spawnSync('git', ['push', '-q', 'origin', 'HEAD'], { cwd, encoding: 'utf8' })
  return { status: pushed.status, stderr: pushed.stderr }
}

describe('a push from a fresh worktree (CC-313)', () => {
  it('reaches the scanner the setup step installed', async () => {
    const repo = makeHookedRepo({ command: ['sh', '-c', STUB_SCANNER] })
    const alloc = await createWorktreeStrategy().allocate(ctxFor(repo))

    const pushed = pushFrom(alloc.cwd)

    expect(setupWarnings(alloc.warnings)).toEqual([])
    expect(pushed).toMatchObject({ status: 0 })
    expect(fs.existsSync(path.join(alloc.cwd, 'scanner-ran'))).toBe(true)
  })

  it('still fails closed when no step installed a scanner', async () => {
    const repo = makeHookedRepo()
    const alloc = await createWorktreeStrategy().allocate(ctxFor(repo))

    const pushed = pushFrom(alloc.cwd)

    expect(pushed.status).not.toBe(0)
    expect(pushed.stderr).toContain('titan-egress-scan: not installed in this worktree')
  })
})
