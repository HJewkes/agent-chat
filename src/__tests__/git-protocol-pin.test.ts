import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentEnv } from '../agents/agent-env.js'
import { childEnv } from '../exec.js'
import { setupEnv } from '@titan-design/worktree'
import { withShims } from '../agents/launch-agent.js'
import type { LaunchPlan } from '../agents/types.js'
import { pinGitProtocols, pinnedGitEnv, runGit } from '../git.js'
import { clearInheritedShimEnv } from '../agents/base-path.js'
import { gitHooksEnv, hooksDirOf } from '../leak-guard/hooks-dir.js'
import { guardContext } from '../leak-guard/pretool.js'

/**
 * CC-1095 (Shepherd rv-316 FIX_FIRST on ac#316 at 0122216b): an `ext::` remote runs a shell
 * command, and a repo's `protocol.ext.allow=always` enables it unless GIT_ALLOW_PROTOCOL says no.
 */

const SAFE = 'file:git:http:https:ssh'
const EXT_NEVER = {
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'protocol.ext.allow',
  GIT_CONFIG_VALUE_0: 'never',
}
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
    [undefined, undefined],
    [SAFE, undefined],
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

  it('leaves the list unset and denies ext by config when the caller has none', () => {
    const env = agentEnv({ PATH: '/usr/bin:/bin' })

    expect(env.GIT_ALLOW_PROTOCOL).toBeUndefined()
    expect(env).toMatchObject(EXT_NEVER)
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

    it('drops a stale legacy list a stored plan carries', () => {
      const base = { PATH: '/usr/bin:/bin' }

      expect(withShims(plan({ GIT_ALLOW_PROTOCOL: SAFE }), base).env.GIT_ALLOW_PROTOCOL).toBeUndefined()
    })

    it('re-appends the ext deny after config pairs the profile sets', () => {
      const base = { PATH: '/usr/bin:/bin', ...EXT_NEVER }
      const profile = {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'protocol.ext.allow',
        GIT_CONFIG_VALUE_0: 'always',
      }

      expect(withShims(plan(profile), base).env).toMatchObject({
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_1: 'protocol.ext.allow',
        GIT_CONFIG_VALUE_1: 'never',
      })
    })

    const launched = (
      planEnv: Record<string, string>,
      base: Record<string, string>,
    ): Record<string, string> => ({
      ...base,
      ...withShims(plan(planEnv), base).env,
    })

    it('keeps the ext deny inside the count when the plan sets fewer pairs than the base', () => {
      const base = { PATH: '/usr/bin:/bin', ...pinnedGitEnv(gitHooksEnv('/old')) }

      const env = launched(gitHooksEnv('/new'), base)

      expect(env).toMatchObject({
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_VALUE_0: '/new',
        GIT_CONFIG_KEY_1: 'protocol.ext.allow',
        GIT_CONFIG_VALUE_1: 'never',
      })
    })

    it("lets the guard read and a later broker clear the hooks dir of a launched agent's env", () => {
      const env = launched(gitHooksEnv('/hooks'), { PATH: '/usr/bin:/bin', HOME: '/h' })

      expect(hooksDirOf(env)).toBe('/hooks')
      expect(guardContext(env, '/work', '/h').protectedPaths).toContain('/hooks')
      clearInheritedShimEnv(env)
      expect(Object.keys(env).filter(name => name.startsWith('GIT_CONFIG_'))).toEqual([])
    })

    it('starts an unguarded launch with no hooks path after a broker inherited an agent env', () => {
      const inherited = launched(gitHooksEnv('/hooks'), { PATH: '/usr/bin:/bin', HOME: '/h' })
      clearInheritedShimEnv(inherited)

      const env = launched({}, pinnedGitEnv(inherited))

      expect(env).toMatchObject(EXT_NEVER)
      expect(hooksDirOf(env)).toBeUndefined()
    })
  })
})

describe('the burndown tick and worktree setup', () => {
  it('pins the tick subprocess env', () => {
    expect(childEnv({ GIT_ALLOW_PROTOCOL: 'ext' }).GIT_ALLOW_PROTOCOL).toBe('')
    expect(childEnv({}).GIT_ALLOW_PROTOCOL).toBeUndefined()
    expect(childEnv({})).toMatchObject(EXT_NEVER)
  })

  it('pins the install env', () => {
    expect(setupEnv({ GIT_ALLOW_PROTOCOL: 'ext' }).GIT_ALLOW_PROTOCOL).toBe('')
    expect(setupEnv({}).GIT_ALLOW_PROTOCOL).toBeUndefined()
  })
})
