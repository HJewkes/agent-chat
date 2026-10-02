import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BASE_PATH_ENV, recordLoginPath, resolveBasePath } from '../agents/base-path.js'
import { agentBaseEnv, withShims } from '../agents/launch-agent.js'
import type { LaunchPlan } from '../agents/types.js'

/**
 * CC-456: a broker autostarted with `PATH=/usr/bin:/bin` handed that PATH to every headless
 * agent, which then had no agent-chat (so no gh-write) and no `/usr/sbin`.
 */

const MINIMAL_PATH = '/usr/bin:/bin'
const MACHINE_DIRS = new Set(['/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/h/.local/bin'])
const onThisMachine = (dir: string): boolean => MACHINE_DIRS.has(dir)

const resolve = (env: NodeJS.ProcessEnv, recorded?: string): string[] =>
  resolveBasePath({ env, stateDir: '/state', isDir: onThisMachine, readFirstLine: () => recorded }).split(':')

describe('the base PATH for the broker and its agents', () => {
  it('adds the agent-chat dir and sbin to a minimal inherited PATH', () => {
    const dirs = resolve({ PATH: MINIMAL_PATH, HOME: '/h' })

    expect(dirs).toEqual(['/usr/bin', '/bin', '/opt/homebrew/bin', '/h/.local/bin', '/usr/sbin', '/sbin'])
  })

  it('keeps inherited entries first, then the override, then the recorded login PATH', () => {
    const env = { PATH: '/shim:/usr/bin', HOME: '/h', [BASE_PATH_ENV]: '/override/bin' }

    const dirs = resolve(env, '/login/bin:/usr/bin')

    expect(dirs.slice(0, 4)).toEqual(['/shim', '/usr/bin', '/override/bin', '/login/bin'])
    expect(new Set(dirs).size).toBe(dirs.length)
  })

  it('skips the home dir when HOME is unset', () => {
    expect(resolve({ PATH: MINIMAL_PATH })).not.toContain('/.local/bin')
  })

  it('records the login PATH and never throws on a failed write', () => {
    const writes: string[] = []

    recordLoginPath('/state', '/a:/b', (file, data) => writes.push(`${file}=${data}`))
    recordLoginPath('/state', '/a:/b', () => {
      throw new Error('read-only')
    })

    expect(writes).toEqual(['/state/login-path=/a:/b\n'])
  })
})

describe('a headless agent launched from a minimal-PATH broker', () => {
  let stateDir: string

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-base-path-'))
    process.env.AGENT_CHAT_HOME = stateDir
  })

  afterEach(() => {
    delete process.env.AGENT_CHAT_HOME
    fs.rmSync(stateDir, { recursive: true, force: true })
  })

  const plan: LaunchPlan = {
    agentId: 'agt-path',
    bin: 'claude',
    args: [],
    cwd: '/work',
    env: {},
    title: 'agt-path',
    surface: 'headless',
  }

  it('gets the agent-chat dir and sbin on PATH with the shims still first', () => {
    const parent = { PATH: MINIMAL_PATH, HOME: '/h' }
    const base = agentBaseEnv(parent, env =>
      resolveBasePath({ env, stateDir: '/state', isDir: onThisMachine, readFirstLine: () => undefined }),
    )

    const withGitShimDir = { ...plan, env: { AGENT_CHAT_GIT_SHIM_DIR: '/state/git-bin' } }

    const dirs = (withShims(withGitShimDir, base).env.PATH ?? '').split(':')

    expect(dirs[0]).toBe('/state/git-bin')
    expect(dirs[1]).toContain(path.join(stateDir, 'gh-shim'))
    expect(dirs).toContain('/opt/homebrew/bin')
    expect(dirs).toContain('/usr/sbin')
  })
})
