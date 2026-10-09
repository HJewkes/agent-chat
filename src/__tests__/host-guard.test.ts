import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { autoAttach } from './broker-harness.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor } from '../agents/supervisor.js'
import { logPath } from '../paths.js'

/**
 * CC-880 — the broker runs on one machine while sessions may reach it from
 * another. A pid is only meaningful on the host that minted it, so nothing may
 * signal a pid whose session did not report the broker's own host.
 */

const REMOTE = 'someone-elses-laptop.invalid'
const tmpDirs: string[] = []
let core: BrokerCore
let supervisor: Supervisor
let stopAutoAttach: () => void
let signals: Array<[number, string]>

const fakeConn = (): Conn => ({}) as unknown as net.Socket

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-hg-'))
  tmpDirs.push(dir)
  return dir
}

beforeEach(() => {
  vi.useFakeTimers()
  signals = []
  vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: unknown) => {
    if (signal !== 0) signals.push([pid, String(signal)])
    return true
  })
  const dir = workspace()
  process.env.AGENT_CHAT_HOME = dir
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(dir, 'active-work')
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
  })
  stopAutoAttach = autoAttach(core)
  supervisor = new Supervisor(core, {
    countdownMs: 1000,
    argvReader: () => 'claude',
    launcherRunning: async () => false,
    surface: {
      platform: 'linux',
      spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }),
      runAppleScript: () => Promise.resolve(''),
    },
  })
})

afterEach(() => {
  stopAutoAttach()
  supervisor.close()
  vi.restoreAllMocks()
  vi.useRealTimers()
  delete process.env.AGENT_CHAT_HOME
  delete process.env.AGENT_CHAT_ACTIVE_WORK_ROOT
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('endSession', () => {
  it('never signals a pid whose session reported another host, and logs why', () => {
    const result = supervisor.endSession('scout', 83212, REMOTE)

    vi.advanceTimersByTime(10_000)
    expect(result.ok).toBe(false)
    expect(signals).toEqual([])
    expect(fs.readFileSync(logPath(), 'utf8')).toContain(REMOTE)
  })

  it('never signals a pid whose session reported no host at all', () => {
    const result = supervisor.endSession('scout', 83212, undefined)

    vi.advanceTimersByTime(10_000)
    expect(result.ok).toBe(false)
    expect(signals).toEqual([])
  })

  it('still signals a pid on the broker’s own host', () => {
    expect(supervisor.endSession('scout', 4321, os.hostname()).ok).toBe(true)

    expect(signals).toEqual([[4321, 'SIGTERM']])
  })
})

describe('registration', () => {
  it('stores the host a session reports on its row', () => {
    const conn = fakeConn()
    core.register(conn, { t: 'register', name: 'mac', workingOn: 'x', cwd: '/tmp', pid: 1, host: REMOTE })

    expect(core.registry.hostFor('mac')).toBe(REMOTE)
  })
})

describe('a teleport the broker cannot complete', () => {
  const adopt = (host: string | undefined): string => {
    const conn = fakeConn()
    core.register(conn, {
      t: 'register',
      name: 'scout',
      workingOn: 'work',
      cwd: workspace(),
      pid: 111,
      sessionId: 'session-uuid-1',
      hostPid: 83212,
      ...(host === undefined ? {} : { host }),
    })
    return core.registry.entryFor(conn)?.agentId as string
  }

  const teleport = (agentId: string, host: string | undefined) =>
    supervisor.teleport({
      subject: {
        agentId,
        name: 'scout',
        cwd: workspace(),
        hostPid: 83212,
        tags: [],
        subscriptions: [],
        ...(host === undefined ? {} : { host }),
      },
      handoff: 'carry on',
    })

  const humanNotices = () => core.events.humanQueue().filter(item => item.text.includes('teleport'))

  /** CC-881 replaced the refusal: the caller's host runs the relaunch, and the broker still signals nobody. */
  it('hands a caller on another host its own relaunch, and ends nobody', async () => {
    const agentId = adopt(REMOTE)

    const result = await teleport(agentId, REMOTE)
    await vi.advanceTimersByTimeAsync(120_000)

    expect(result).toMatchObject({ ok: true, remote: true })
    expect(signals).toEqual([])
  })

  it('errors when the session reported no host, rather than assuming it is local', async () => {
    const agentId = adopt(undefined)

    const result = await teleport(agentId, undefined)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(result.ok).toBe(false)
    expect(humanNotices()).toHaveLength(1)
    expect(signals).toEqual([])
  })

  it('errors on an iTerm surface this platform lacks, notifies once, and keeps the predecessor', async () => {
    const agentId = adopt(os.hostname())
    core.append({ kind: 'agent_spawned', actor: 'human', target: 'x', msgId: 'other', body: 'b' })
    vi.spyOn(supervisor as unknown as { resolve: () => string }, 'resolve').mockReturnValue('iterm-pane')

    const result = await teleport(agentId, os.hostname())
    await vi.advanceTimersByTimeAsync(60_000)

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/macOS|iterm/i)
    expect(humanNotices()).toHaveLength(1)
    expect(signals).toEqual([])
  })
})
