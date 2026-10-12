import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentEnv } from '../agents/agent-env.js'
import { childEnv } from '../agents/burndown/exec.js'
import { setupEnv } from '../agents/isolation/worktree-setup.js'
import { withShims } from '../agents/launch-agent.js'
import type { LaunchPlan } from '../agents/types.js'
import { pinGitProtocols, runGit } from '../git.js'

/**
 * CC-1095 (Shepherd rv-316 FIX_FIRST on ac#316 at 0122216b): an `ext::` remote runs a shell
 * command, and a repo's `protocol.ext.allow=always` enables it unless GIT_ALLOW_PROTOCOL says no.
 */

const SAFE = 'file:git:http:https:ssh'
const dirs: string[] = []

const scratch = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}

/** A repo whose remote `x` touches `marker` when git is allowed to run it. */
function extRemoteRepo(): { repo: string; marker: string } {
  const dir = scratch('git-pin-')
  const repo = path.join(dir, 'r')
  const marker = path.join(dir, 'marker')
  const git = (...args: string[]): void => {
    execFileSync('git', args, {
      cwd: dir,
      env: { ...process.env, GIT_ALLOW_PROTOCOL: SAFE },
      stdio: 'ignore',
    })
  }
  git('init', '--quiet', repo)
  git('-C', repo, 'config', 'protocol.ext.allow', 'always')
  git('-C', repo, 'remote', 'add', 'x', `ext::sh -c touch% ${marker}`)
  return { repo, marker }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('pinGitProtocols', () => {
  it.each([
    [undefined, SAFE],
    ['ext', ''],
    ['https:ext:ssh', 'https:ssh'],
    ['EXT:https', 'https'],
    ['next:https', 'https'],
    ['HTTPS:sshx', ''],
    ['', ''],
    ['https', 'https'],
  ])('narrows %j to %j', (value, pinned) => {
    expect(pinGitProtocols(value)).toBe(pinned)
  })
})

describe('git that agent-chat runs itself', () => {
  let saved: string | undefined

  beforeEach(() => {
    saved = process.env.GIT_ALLOW_PROTOCOL
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.GIT_ALLOW_PROTOCOL
    else process.env.GIT_ALLOW_PROTOCOL = saved
  })

  it.each([['ext'], [undefined]])(
    'never runs an ext:: remote when the broker has GIT_ALLOW_PROTOCOL=%j',
    async value => {
      if (value === undefined) delete process.env.GIT_ALLOW_PROTOCOL
      else process.env.GIT_ALLOW_PROTOCOL = value
      const { repo, marker } = extRemoteRepo()

      const out = await runGit(['fetch', 'x'], repo)

      expect(out).toBeNull()
      expect(fs.existsSync(marker)).toBe(false)
    },
  )
})

describe('the env a spawned agent gets', () => {
  it('drops ext from the caller list and keeps the rest', () => {
    expect(agentEnv({ GIT_ALLOW_PROTOCOL: 'ext:https', PATH: '/usr/bin:/bin' }).GIT_ALLOW_PROTOCOL).toBe(
      'https',
    )
  })

  it('gives the safe list when the caller has none', () => {
    expect(agentEnv({ PATH: '/usr/bin:/bin' }).GIT_ALLOW_PROTOCOL).toBe(SAFE)
  })

  it.each([['ext'], [undefined]])(
    'keeps a git fetch under it from running an ext:: remote (caller %j)',
    value => {
      const parent = { ...process.env, GIT_ALLOW_PROTOCOL: value }
      const { repo, marker } = extRemoteRepo()

      const run = spawnSync('git', ['fetch', 'x'], { cwd: repo, env: agentEnv(parent), encoding: 'utf8' })

      expect(run.status).not.toBe(0)
      expect(run.stderr).toContain("transport 'ext' not allowed")
      expect(fs.existsSync(marker)).toBe(false)
    },
  )

  describe('with a profile env layered over the base', () => {
    let stateDir: string

    beforeEach(() => {
      stateDir = scratch('git-pin-state-')
      process.env.AGENT_CHAT_HOME = stateDir
    })

    afterEach(() => {
      delete process.env.AGENT_CHAT_HOME
    })

    const plan = (env: Record<string, string>): LaunchPlan => ({
      agentId: 'agt-pin',
      bin: 'claude',
      args: [],
      cwd: '/work',
      env,
      title: 'agt-pin',
      surface: 'headless',
    })

    it('cannot widen the list to ext', () => {
      const base = { PATH: '/usr/bin:/bin', GIT_ALLOW_PROTOCOL: SAFE }

      expect(withShims(plan({ GIT_ALLOW_PROTOCOL: 'ext:ssh' }), base).env.GIT_ALLOW_PROTOCOL).toBe('ssh')
    })

    it('carries the pinned list when the profile sets none', () => {
      const base = { PATH: '/usr/bin:/bin' }

      expect(withShims(plan({}), base).env.GIT_ALLOW_PROTOCOL).toBe(SAFE)
    })
  })
})

describe('the burndown tick and worktree setup', () => {
  it('pins the tick subprocess env', () => {
    expect(childEnv({ GIT_ALLOW_PROTOCOL: 'ext' }).GIT_ALLOW_PROTOCOL).toBe('')
    expect(childEnv({}).GIT_ALLOW_PROTOCOL).toBe(SAFE)
  })

  it('pins the install env', () => {
    expect(setupEnv({ GIT_ALLOW_PROTOCOL: 'ext' }).GIT_ALLOW_PROTOCOL).toBe('')
    expect(setupEnv({}).GIT_ALLOW_PROTOCOL).toBe(SAFE)
  })
})
