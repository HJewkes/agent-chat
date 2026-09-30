import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWorktreeStrategy, reattachWorktree } from '../agents/isolation/worktree.js'
import {
  parseSetupStep,
  runSetupCommand,
  SETUP_FILE,
  SETUP_LOG,
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

const declare = (dir: string, content: string): void => {
  fs.mkdirSync(path.join(dir, '.agent-chat'), { recursive: true })
  fs.writeFileSync(path.join(dir, SETUP_FILE), content)
}

/** Commits a declaration on whatever branch `dir` has checked out. */
const commitDeclaration = (dir: string, command: string[]): void => {
  declare(dir, JSON.stringify({ setup: { command } }))
  git(['add', '.'], dir)
  git(['commit', '-m', 'change the setup step'], dir)
}

/** A synthetic repository with one commit, whose declaration file holds `content` when given. */
function makeLocalRepo(content?: string): string {
  const dir = tmpdir('wt-setup-')
  git(['init', '-b', 'main'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  git(['config', 'user.name', 'Test'], dir)
  git(['config', 'commit.gpgsign', 'false'], dir)
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n')
  if (content !== undefined) declare(dir, content)
  git(['add', '.'], dir)
  git(['commit', '-m', 'seed'], dir)
  return dir
}

/** The same, pushed to a bare origin, so its default branch is the one a declaration is trusted from. */
function makeRepoHolding(content?: string): string {
  const repo = makeLocalRepo(content)
  const origin = tmpdir('wt-origin-')
  git(['init', '--bare', '-b', 'main'], origin)
  git(['remote', 'add', 'origin', origin], repo)
  git(['push', '-q', 'origin', 'main'], repo)
  return repo
}

const makeRepo = (setup?: object): string =>
  makeRepoHolding(setup === undefined ? undefined : JSON.stringify({ setup }))

/** A branch with one commit of its own that declares `command`, checked out nowhere. */
function branchDeclaring(repo: string, branch: string, command: string[]): void {
  git(['switch', '-q', '-c', branch], repo)
  commitDeclaration(repo, command)
  git(['switch', '-q', 'main'], repo)
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
    expect(setupWarnings(alloc.warnings)).toEqual([expect.stringContaining('`npm ci` exited with code 1')])
  })

  it('keeps the step output out of the warning and in an owner-only log outside the tree', async () => {
    const repo = makeRepo({ command: ['npm', 'ci'] })
    const output = 'npm ERR! 401 //registry.example/:_authToken=synthetic-value\n'
    const { runner } = recording({ exitCode: 1, timedOut: false, output })

    const alloc = await createWorktreeStrategy({ runSetup: runner }).allocate(ctxFor(repo))

    const log = path.join(git(['rev-parse', '--absolute-git-dir'], alloc.cwd), SETUP_LOG)
    const [warning] = setupWarnings(alloc.warnings)
    expect(warning).not.toContain('synthetic-value')
    expect(warning).toContain(`its output is in ${log}`)
    expect(fs.readFileSync(log, 'utf8')).toBe(output)
    expect(fs.statSync(log).mode & 0o777).toBe(0o600)
    expect(git(['status', '--porcelain'], alloc.cwd)).toBe('')
  })

  it('reports a step that was killed by the timeout even though it exited 0', async () => {
    const repo = makeRepo({ command: ['npm', 'ci'], timeoutMs: 50 })
    const { runner } = recording({ exitCode: 0, timedOut: true, output: '' })

    const alloc = await createWorktreeStrategy({ runSetup: runner }).allocate(ctxFor(repo))

    expect(setupWarnings(alloc.warnings)).toEqual([
      expect.stringContaining('`npm ci` timed out after 50ms and was killed'),
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

  it('warns and runs nothing when the declaration file is empty', async () => {
    const repo = makeRepoHolding('')
    const { runner, calls } = recording()

    const alloc = await createWorktreeStrategy({ runSetup: runner }).allocate(ctxFor(repo))

    expect(calls).toEqual([])
    expect(setupWarnings(alloc.warnings)).toEqual([`worktree setup skipped: ${SETUP_FILE} is empty`])
  })

  it('warns and does not throw when setup is null', async () => {
    const repo = makeRepoHolding('{"setup":null}')
    const { runner, calls } = recording()

    const alloc = await createWorktreeStrategy({ runSetup: runner }).allocate(ctxFor(repo))

    expect(calls).toEqual([])
    expect(setupWarnings(alloc.warnings)).toEqual([expect.stringContaining('setup must be an object')])
  })

  it('ignores keys it does not know and still runs the step as argv', async () => {
    const declared = { setup: { command: ['npm', 'ci'], shell: true, env: { X: '1' } }, later: [1] }
    const repo = makeRepoHolding(JSON.stringify(declared))
    const { runner, calls } = recording()

    const alloc = await createWorktreeStrategy({ runSetup: runner }).allocate(ctxFor(repo))

    expect(calls.map(c => c.command)).toEqual([['npm', 'ci']])
    expect(setupWarnings(alloc.warnings)).toEqual([])
    expect(parseSetupStep(JSON.stringify(declared))).toEqual({ command: ['npm', 'ci'], timeoutMs: 300_000 })
  })
})

describe('where the setup declaration is read from', () => {
  it('a new allocation runs origin default, not the unpushed or uncommitted local one', async () => {
    const repo = makeRepo({ command: ['default-step'] })
    commitDeclaration(repo, ['unpushed-step'])
    declare(repo, JSON.stringify({ setup: { command: ['uncommitted-step'] } }))
    const { runner, calls } = recording()

    await createWorktreeStrategy({ runSetup: runner }).allocate(ctxFor(repo))

    expect(calls.map(c => c.command)).toEqual([['default-step']])
  })

  it('a reused branch with prior commits runs origin default, not its own declaration', async () => {
    const repo = makeRepo({ command: ['default-step'] })
    branchDeclaring(repo, 'agent-chat/alice', ['branch-step'])
    const { runner, calls } = recording()

    const alloc = await createWorktreeStrategy({ runSetup: runner }).allocate(ctxFor(repo))

    expect(alloc.ref?.reused).toBe('true')
    expect(fs.readFileSync(path.join(alloc.cwd, SETUP_FILE), 'utf8')).toContain('branch-step')
    expect(calls).toEqual([{ command: ['default-step'], cwd: alloc.cwd, treeExisted: true }])
  })

  it('a resume that re-creates a parked tree runs origin default, not the branch declaration', async () => {
    const repo = makeRepo({ command: ['default-step'] })
    const first = await createWorktreeStrategy({ runSetup: recording().runner }).allocate(ctxFor(repo))
    commitDeclaration(first.cwd, ['branch-step'])
    git(['worktree', 'remove', '--force', first.cwd], repo)
    const { runner, calls } = recording()

    const record = { gitRoot: repo, worktree: first.cwd, branch: first.ref?.branch ?? '' }
    const again = await reattachWorktree(record, { runSetup: runner })

    expect(again.ref?.reattached).toBe('local')
    expect(fs.readFileSync(path.join(again.cwd, SETUP_FILE), 'utf8')).toContain('branch-step')
    expect(calls.map(c => c.command)).toEqual([['default-step']])
  })

  it('runs nothing when only the branch declares a step', async () => {
    const repo = makeRepo()
    branchDeclaring(repo, 'agent-chat/alice', ['branch-step'])
    const { runner, calls } = recording()

    const alloc = await createWorktreeStrategy({ runSetup: runner }).allocate(ctxFor(repo))

    expect(alloc.ref?.reused).toBe('true')
    expect(calls).toEqual([])
    expect(setupWarnings(alloc.warnings)).toEqual([])
  })

  it('runs nothing and says so when the base is a local HEAD because origin is absent', async () => {
    const repo = makeLocalRepo(JSON.stringify({ setup: { command: ['local-step'] } }))
    const { runner, calls } = recording()

    const alloc = await createWorktreeStrategy({ runSetup: runner }).allocate(ctxFor(repo))

    expect(calls).toEqual([])
    expect(setupWarnings(alloc.warnings)).toEqual([expect.stringContaining('worktree setup skipped')])
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

  it('passes the step PATH but not the rest of the broker environment', async () => {
    const dir = tmpdir('wt-run-')
    process.env.CC313_BROKER_SECRET = 'synthetic-value'
    try {
      const result = await runSetupCommand(['sh', '-c', 'env'], dir, 5_000)
      expect(result.output).toContain('PATH=')
      expect(result.output).not.toContain('CC313_BROKER_SECRET')
    } finally {
      delete process.env.CC313_BROKER_SECRET
    }
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
