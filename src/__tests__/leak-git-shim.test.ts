import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { writeLaunchFiles } from '../agents/launch-files.js'
import { buildLaunchPlan } from '../agents/launch-plan.js'
import type { AgentProfile, LaunchPlan, LaunchPlanInput } from '../agents/types.js'
import { findRealGit, GIT_SHIM_DIR_ENV, gitShimScript, writeGitShim } from '../leak-guard/git-shim.js'
import { gitHooksEnv } from '../leak-guard/hooks-dir.js'

/**
 * TP-596, against real git, temp repos and a local bare remote. Each push test names the
 * mutation of the shim it kills; the negative controls are in the PR description.
 */

const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-git-shim-')))

afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }))

const REAL_GIT = findRealGit(process.env.PATH ?? '', path.join(SCRATCH, 'none')) as string
const NO_VERIFY = ['--no', 'verify'].join('-')

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(REAL_GIT, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })

interface Fixture {
  work: string
  remote: string
  guard: string
  shimDir: string
  marker: string
  env: Record<string, string> & { PATH: string }
}

let count = 0

/** A repo with one commit, a bare remote, a guard dir whose pre-push leaves a marker, and the shim. */
function fixture(): Fixture {
  const root = path.join(SCRATCH, `case-${++count}`)
  const work = path.join(root, 'work')
  const remote = path.join(root, 'remote.git')
  const guard = path.join(root, 'git-hooks')
  const shimDir = path.join(root, 'git-bin')
  const home = path.join(root, 'home')
  const marker = path.join(root, 'pre-push-ran')
  for (const dir of [work, guard, home]) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(guard, 'pre-push'), `#!/bin/sh\ncat >/dev/null\ntouch '${marker}'\n`, {
    mode: 0o755,
  })
  git(root, 'init', '-q', '--bare', remote)
  git(work, 'init', '-q', '-b', 'main')
  git(
    work,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.com',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'one',
  )
  git(work, 'remote', 'add', 'origin', remote)
  expect(writeGitShim(shimDir, guard)).toBe(true)
  const env = {
    PATH: `${shimDir}:/usr/bin:/bin`,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    ...gitHooksEnv(guard),
  }
  return { work, remote, guard, shimDir, marker, env }
}

/** Runs a script file, as make or an npm script would; a recursing shim is killed by the timeout. */
function runScript(
  fx: Fixture,
  body: string,
): ReturnType<typeof spawnSync> & { stdout: string; stderr: string } {
  const script = path.join(fx.work, '..', `script-${++count}.sh`)
  fs.writeFileSync(script, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return spawnSync(script, { cwd: fx.work, env: fx.env, encoding: 'utf8', timeout: 10_000 })
}

const remoteHasMain = (fx: Fixture): boolean =>
  spawnSync(REAL_GIT, ['--git-dir', fx.remote, 'rev-parse', '-q', '--verify', 'refs/heads/main']).status === 0

describe('the agent git shim refusing pushes that skip the leak scan', () => {
  // Kills: the argv check removed.
  it('refuses push --no-verify run from a script file', () => {
    const fx = fixture()

    const run = runScript(fx, `git push -q ${NO_VERIFY} origin main`)

    expect(run.stderr).toContain('git-shim: push refused (no-verify)')
    expect(run.status).not.toBe(0)
    expect(remoteHasMain(fx)).toBe(false)
  })

  // Kills: the hooks-path comparison removed.
  it('refuses a push from a script that sets GIT_CONFIG_COUNT=0', () => {
    const fx = fixture()

    const run = runScript(fx, 'GIT_CONFIG_COUNT=0 git push -q origin main')

    expect(run.stderr).toContain('git-shim: push refused (hooks-path)')
    expect(run.status).not.toBe(0)
    expect(remoteHasMain(fx)).toBe(false)
  })

  it('refuses a push whose -c option points core.hooksPath elsewhere', () => {
    const fx = fixture()

    const run = runScript(fx, 'git -c core.hooksPath=/dev/null push -q origin main')

    expect(run.stderr).toContain('git-shim: push refused (hooks-path)')
    expect(remoteHasMain(fx)).toBe(false)
  })

  // Kills: alias resolution removed.
  it('refuses git p when a repo alias expands to push --no-verify', () => {
    const fx = fixture()
    git(fx.work, 'config', 'alias.p', `push ${NO_VERIFY}`)

    const run = runScript(fx, 'git p -q origin main')

    expect(run.stderr).toContain('git-shim: push refused (no-verify)')
    expect(run.status).not.toBe(0)
    expect(remoteHasMain(fx)).toBe(false)
  })

  it('refuses an alias chain that reaches push --no-verify through a second alias', () => {
    const fx = fixture()
    git(fx.work, 'config', 'alias.p', 'q -q')
    git(fx.work, 'config', 'alias.q', `push ${NO_VERIFY}`)

    const run = runScript(fx, 'git --no-pager p origin main')

    expect(run.stderr).toContain('git-shim: push refused (no-verify)')
    expect(remoteHasMain(fx)).toBe(false)
  })

  it('refuses a shell alias that pushes', () => {
    const fx = fixture()
    git(fx.work, 'config', 'alias.ship', `!git push ${NO_VERIFY} origin main`)

    const run = runScript(fx, 'git ship')

    expect(run.stderr).toContain('git-shim: push refused (shell-alias)')
    expect(remoteHasMain(fx)).toBe(false)
  })
})

describe('the agent git shim failing closed when it cannot resolve a push (fix round 1)', () => {
  // Each case pushed without the hook at 789da5ba: sh word splitting kept the quotes, so the lookup missed.
  it.each([
    ['"push"', `git p ${NO_VERIFY} origin main`, 'no-verify'],
    ["'push'", 'git -c core.hooksPath=/dev/null p origin main', 'hooks-path'],
    ['pu\\sh', `git p ${NO_VERIFY} origin main`, 'no-verify'],
    ['"push" "--no-verify"', 'git p origin main', 'no-verify'],
  ])('refuses alias.p=%s split the way git splits it', (alias, command, rule) => {
    const fx = fixture()
    git(fx.work, 'config', 'alias.p', alias)

    const run = runScript(fx, command)

    expect(run.stderr).toContain(`git-shim: push refused (${rule})`)
    expect(run.status).toBe(2)
    expect(remoteHasMain(fx)).toBe(false)
  })

  it('refuses an alias with an open quote rather than passing it to git', () => {
    const fx = fixture()
    git(fx.work, 'config', 'alias.p', '"push')

    const run = runScript(fx, 'git p origin main')

    expect(run.stderr).toContain('git-shim: push refused (unresolved)')
    expect(run.status).toBe(2)
  })

  it('refuses an alias chain deeper than 10 that ends in push --no-verify', () => {
    const fx = fixture()
    for (let level = 0; level < 12; level++) git(fx.work, 'config', `alias.a${level}`, `a${level + 1}`)
    git(fx.work, 'config', 'alias.a12', `push ${NO_VERIFY}`)

    const run = runScript(fx, 'git a0 origin main')

    expect(run.stderr).toContain('git-shim: push refused (alias-depth)')
    expect(run.status).toBe(2)
    expect(remoteHasMain(fx)).toBe(false)
  })

  it.each([
    [`git push ${NO_VERIFY} origin main`, 'no-verify'],
    ['git -c core.hooksPath=/dev/null push origin main', 'hooks-path'],
  ])('refuses %s when the builtin list could not be read', (command, rule) => {
    const fx = fixture()
    const real = findRealGit(process.env.PATH ?? '', fx.shimDir) as string
    fs.writeFileSync(path.join(fx.shimDir, 'git'), gitShimScript(real, fx.guard, []), { mode: 0o755 })

    const run = runScript(fx, command)
    const status = runScript(fx, 'git rev-parse --verify -q refs/heads/absent; echo "status=$?"')

    expect(run.stderr).toContain(`git-shim: push refused (${rule})`)
    expect(remoteHasMain(fx)).toBe(false)
    expect(status.stdout.trim()).toBe('status=1')
  })

  // At 789da5ba the inner git refused as no-verify; the outer shim now names the shell alias itself.
  it.each([
    ['!git', `git g push ${NO_VERIFY} origin main`],
    ["!git pu''sh origin main", 'git g'],
  ])('refuses the shell alias %s when it or its arguments mention push', (alias, command) => {
    const fx = fixture()
    git(fx.work, 'config', 'alias.g', alias)

    const run = runScript(fx, command)

    expect(run.stderr).toContain('git-shim: push refused (shell-alias)')
    expect(remoteHasMain(fx)).toBe(false)
  })

  it('still runs a shell alias that does not mention push', () => {
    const fx = fixture()
    git(fx.work, 'config', 'alias.hi', '!echo hello')

    const run = runScript(fx, 'git hi')

    expect(run.stdout.trim()).toBe('hello')
    expect(run.status).toBe(0)
  })
})

describe('the agent git shim passing everything else to the real git', () => {
  // Kills: the shim not exec-ing the real git.
  it('lets a plain push through and the pre-push hook still runs', () => {
    const fx = fixture()

    const run = runScript(fx, 'git -C . push -q origin main')

    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(remoteHasMain(fx)).toBe(true)
    expect(fs.existsSync(fx.marker)).toBe(true)
  })

  // Kills: the exit status or stdout swallowed.
  it('passes other subcommands through with their exit code and stdout', () => {
    const fx = fixture()

    const head = runScript(fx, 'git rev-parse HEAD')
    const missing = runScript(fx, 'git cat-file -e 0000000000000000000000000000000000000001')
    const failed = runScript(fx, 'git rev-parse --verify -q refs/heads/absent; echo "status=$?"')

    expect(head.stdout.trim()).toBe(git(fx.work, 'rev-parse', 'HEAD').trim())
    expect(head.status).toBe(0)
    expect(missing.status).toBe(
      spawnSync(REAL_GIT, ['cat-file', '-e', '0000000000000000000000000000000000000001'], { cwd: fx.work })
        .status,
    )
    expect(failed.stdout.trim()).toBe('status=1')
  })

  // Kills: the shim calling git by name, which finds itself first on PATH (timeout).
  it('does not recurse into itself', () => {
    const fx = fixture()
    writeGitShim(fx.shimDir, fx.guard, `${fx.env.PATH}:${process.env.PATH ?? ''}`)

    const run = runScript(fx, 'git --version && git status --short && git push -q origin main')

    expect(run.error).toBeUndefined()
    expect(run.status).toBe(0)
    expect(run.stdout).toMatch(/^git version /)
    expect(remoteHasMain(fx)).toBe(true)
  })
})

describe('where the agent git shim is put on PATH', () => {
  const profile: AgentProfile = {
    name: 'test',
    description: 'a profile',
    model: 'sonnet',
    allowedTools: ['Read'],
    isolation: 'none',
    surface: 'headless',
    promptPrelude: '',
  }
  const input = (over: Partial<LaunchPlanInput> = {}): LaunchPlanInput => ({
    agentId: 'ag000001',
    sessionId: '00000000-0000-4000-8000-000000000001',
    name: 'scout',
    profile,
    brief: 'brief',
    cwd: '/repo',
    mcpConfigPath: '/state/agents/ag000001/mcp.json',
    ...over,
  })

  it('names <home>/git-bin in the plan only when the guard hooks are set, and a profile cannot move it', () => {
    const hostile = { ...profile, env: { [GIT_SHIM_DIR_ENV]: '/elsewhere', PATH: '/usr/bin' } }

    const guarded = buildLaunchPlan(input({ profile: hostile, gitHooksDir: '/state/git-hooks' }))

    expect(guarded.env[GIT_SHIM_DIR_ENV]).toBe('/state/git-bin')
    expect(GIT_SHIM_DIR_ENV in buildLaunchPlan(input()).env).toBe(false)
  })

  it('writes <home>/git-bin/git beside the guard hooks at spawn, and nothing without them', () => {
    const home = fs.mkdtempSync(path.join(SCRATCH, 'home-'))
    process.env.AGENT_CHAT_HOME = home
    const hooks = path.join(home, 'git-hooks')
    const shim = path.join(home, 'git-bin', 'git')
    try {
      writeLaunchFiles(buildLaunchPlan(input()), {})
      expect(fs.existsSync(shim)).toBe(false)

      writeLaunchFiles(buildLaunchPlan(input({ gitHooksDir: hooks })), {})
    } finally {
      delete process.env.AGENT_CHAT_HOME
    }

    expect(fs.statSync(shim).mode & 0o777).toBe(0o755)
    expect(fs.readFileSync(shim, 'utf8')).toContain(`guard='${hooks}'`)
  })

  const CLI = path.join(import.meta.dirname, '..', '..', 'dist', 'cli.js')

  /** The PATH the launched process sees, from the built `run-agent`. */
  function launchedPath(planEnv: Record<string, string>): string[] {
    const state = fs.mkdtempSync(path.join(SCRATCH, 'state-'))
    const fake = path.join(state, 'fake-claude.js')
    fs.writeFileSync(fake, 'process.stdout.write(process.env.PATH)\n')
    const plan: LaunchPlan = {
      agentId: 'agt-test',
      bin: 'claude',
      args: [fake],
      cwd: state,
      env: planEnv,
      title: 'agt-test',
      surface: 'headless',
    }
    fs.mkdirSync(path.join(state, 'agents', 'agt-test'), { recursive: true })
    fs.writeFileSync(path.join(state, 'agents', 'agt-test', 'plan.json'), JSON.stringify(plan))
    const run = spawnSync(process.execPath, [CLI, 'run-agent', 'agt-test'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', AGENT_CHAT_HOME: state, AGENT_CHAT_CLAUDE: process.execPath },
    })
    return run.stdout.split(':')
  }

  it('puts the shim dir first on an agent launch PATH, ahead of a PATH the plan sets', () => {
    const entries = launchedPath({ [GIT_SHIM_DIR_ENV]: '/state/git-bin', PATH: '/plan/bin' })

    expect(entries[0]).toBe('/state/git-bin')
    expect(entries).toContain('/plan/bin')
  })

  // Kills: the prepend applied outside the agent launch path.
  it('a human launch env has no shim dir on PATH', () => {
    const before = process.env.PATH
    const entries = launchedPath({})

    expect(entries.some(entry => entry.endsWith('git-bin'))).toBe(false)
    expect(process.env.PATH).toBe(before)
  })
})
