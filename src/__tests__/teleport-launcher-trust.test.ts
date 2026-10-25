import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { autoAttach } from './broker-harness.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor } from '../agents/supervisor.js'
import type { HostProbe, RemoteLaunch } from '../protocol.js'
import type { LauncherSite } from '../agents/teleport.js'

/**
 * CC-1081 b: a cross-machine teleport whose destination launcher refuses the probe because its
 * account never trusted the cwd is refused before anyone is ended. The launcher is faked; no
 * process is launched or signalled, and every host, path and name here is synthetic.
 */

const LAPTOP = 'laptop-host'
const TRUST_REASON =
  'workspace trust prompt: Claude Code on laptop-host has no accepted trust entry for /h/projects/x in /h/.claude.json'

const tmpDirs: string[] = []
let core: BrokerCore
let supervisor: Supervisor
let stopAutoAttach: () => void
let signalled: Array<{ pid: number; signal: unknown }>
let probes: HostProbe[]
let launches: RemoteLaunch[]

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

const refusingOnTrust: LauncherSite = {
  launchers: () => [{ host: LAPTOP, platform: 'linux', proved: true }],
  surfacesOn: () => ['headless', 'tmux-window'],
  probe: (_host, probe) => {
    probes.push(probe)
    return Promise.resolve({ ok: false, reason: TRUST_REASON })
  },
  launch: (_host, launch) => {
    launches.push(launch)
    return Promise.resolve({ ok: true })
  },
}

beforeEach(() => {
  signalled = []
  probes = []
  launches = []
  vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: unknown) => {
    signalled.push({ pid, signal })
    return true
  })
  const home = tempDir('ac-tele-trust-')
  process.env.AGENT_CHAT_HOME = home
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ machines: { laptop: LAPTOP } }))
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(home, 'active-work')
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(home, 'events.db')),
    registry: new Registry<Conn>(),
  })
  stopAutoAttach = autoAttach(core)
  supervisor = new Supervisor(core, {
    countdownMs: 1000,
    hosts: refusingOnTrust,
    argvReader: () => 'claude',
    launcherRunning: async () => false,
    seatTeleport: {
      autonomyRoot: tempDir('ac-seat-'),
      now: () => new Date(),
      shepherd: async () => undefined,
    },
    surface: {
      platform: 'linux',
      spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }),
    },
  })
})

afterEach(() => {
  stopAutoAttach()
  supervisor.close()
  core.close()
  vi.restoreAllMocks()
  delete process.env.AGENT_CHAT_HOME
  delete process.env.AGENT_CHAT_ACTIVE_WORK_ROOT
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

async function spawnScout(): Promise<string> {
  const result = await supervisor.spawn({
    name: 'scout',
    profile: 'explorer',
    brief: 'read the log',
    requestedBy: 'human',
    cwd: tempDir('ac-ws-'),
    isolation: 'none',
    surface: 'headless',
  })
  expect(result.ok).toBe(true)
  return result.agentId as string
}

const teleportToLaptop = (agentId: string) =>
  supervisor.teleport({
    subject: {
      agentId,
      name: 'scout',
      // Both under home, so the broker's own path check passes and the launcher's probe decides;
      // an explicit config dir keeps the runner's own (often outside home on CI) out of it.
      cwd: path.join(os.homedir(), 'projects', 'untrusted-x'),
      configDir: path.join(os.homedir(), '.claude-profiles', 'agents'),
      hostPid: 9999,
      host: os.hostname(),
      tags: [],
      subscriptions: [],
    },
    handoff: 'carry on',
    surface: 'headless',
    to: LAPTOP,
  })

const successorRows = (agentId: string) =>
  core.events.agentEvents().filter(r => r.kind === 'agent_spawned' && r.msgId !== agentId)

describe('a teleport to a machine whose launcher refuses on workspace trust', () => {
  it('is refused before anyone is ended, and the predecessor stays live', async () => {
    const agentId = await spawnScout()
    const kindsBefore = core.events.agentEvents().map(r => r.kind)

    const result = await teleportToLaptop(agentId)

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('workspace trust prompt')
    expect(result.reason).toContain('scout was not ended')
    expect(probes).toHaveLength(1)
    expect(launches).toEqual([])
    expect(signalled.filter(s => s.pid === 9999)).toEqual([])
    expect(successorRows(agentId)).toEqual([])
    expect(core.events.agentEvents().map(r => r.kind)).toEqual(kindsBefore)
  })
})
