import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TmpFs, TmpStat } from '../agents/agent-tmpdir.js'
import { launchExitHook, launchOptions, launchTmpRoot } from '../agents/launch-agent.js'

const UID = 1000
const HOME = '/home/example'
const DISK_ROOT = `${HOME}/.cache/agent-chat/tmp`

/** In-memory dirs owned by UID; nothing touches the real /tmp or home. */
class FakeFs implements TmpFs {
  readonly dirs = new Set<string>(['/tmp'])
  lstat(path: string): TmpStat | undefined {
    if (!this.dirs.has(path)) return undefined
    return { uid: UID, isDirectory: () => true, isSymbolicLink: () => false }
  }
  readdir(): string[] {
    return []
  }
  mkdir(path: string, _mode: number, recursive = false): void {
    if (this.dirs.has(path) && !recursive) throw Object.assign(new Error('exists'), { code: 'EEXIST' })
    this.dirs.add(path)
  }
  chmod(): void {}
  rm(path: string): void {
    this.dirs.delete(path)
  }
}

const reviewer = { AGENT_CHAT_NAME: 'pr-9-review', AGENT_CHAT_PROFILE: 'reviewer' }
const implementer = { AGENT_CHAT_NAME: 'seat-a-impl', AGENT_CHAT_PROFILE: 'implementer' }
const coordinator = { AGENT_CHAT_NAME: 'seat-a', AGENT_CHAT_PROFILE: 'coordinator' }

function baseEnvFor(env: Record<string, string>, platform: NodeJS.Platform): Record<string, string> {
  const root = launchTmpRoot(platform, HOME)
  const options = launchOptions('agent-1', env.AGENT_CHAT_NAME, {
    root,
    platform,
    fs: new FakeFs(),
    uid: UID,
  })
  return options.baseEnv ?? {}
}

beforeEach(() => {
  vi.stubEnv('TMPDIR', '/tmp')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('a launch TMPDIR root (CC-1184, CC-1264)', () => {
  it('puts a Linux reviewer TMPDIR under the home disk root', () => {
    const env = baseEnvFor(reviewer, 'linux')

    const own = `${DISK_ROOT}/ac-pr-9-review-${process.pid}`
    expect([env.TMPDIR, env.TMP, env.TEMP]).toEqual([own, own, own])
  })

  it('puts a Linux implementer TMPDIR under the home disk root', () => {
    const env = baseEnvFor(implementer, 'linux')

    const own = `${DISK_ROOT}/ac-seat-a-impl-${process.pid}`
    expect([env.TMPDIR, env.TMP, env.TEMP]).toEqual([own, own, own])
  })

  it('puts a Linux coordinator TMPDIR under the home disk root', () => {
    const env = baseEnvFor(coordinator, 'linux')

    expect(env.TMPDIR).toBe(`${DISK_ROOT}/ac-seat-a-${process.pid}`)
  })

  it('leaves a macOS launch TMPDIR off the disk root', () => {
    expect(launchTmpRoot('darwin', HOME)).toBe('/tmp')

    expect(baseEnvFor(implementer, 'darwin').TMPDIR).toBe('/tmp')
    expect(baseEnvFor(reviewer, 'darwin').TMPDIR).toBe('/tmp')
  })

  it('removes the TMPDIR at exit from the root it was made under', () => {
    const removeTmp = vi.fn()
    const hook = launchExitHook('agent-1', 'seat-a-impl', DISK_ROOT, {
      reap: vi.fn(),
      removeTmp,
      removeKey: vi.fn(),
    })

    hook()

    expect(removeTmp).toHaveBeenCalledWith(
      'seat-a-impl',
      'agent-1',
      process.pid,
      expect.anything(),
      DISK_ROOT,
    )
  })
})
