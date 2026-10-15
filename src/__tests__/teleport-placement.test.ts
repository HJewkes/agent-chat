import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { autoAttach } from './broker-harness.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor } from '../agents/supervisor.js'
import type { LauncherSite, TeleportOutcome } from '../agents/teleport.js'

/** CC-1357: the placement a teleporting session is told matches where routing puts its successor. */

const LAPTOP = 'laptop-host'
const OTHER = 'someone-elses-laptop.invalid'

const tmpDirs: string[] = []
let core: BrokerCore
let supervisor: Supervisor
let stopAutoAttach: () => void

const tempDir = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

const launcher: LauncherSite = {
  launchers: () => [{ host: LAPTOP, platform: 'linux' }],
  surfacesOn: () => ['headless', 'tmux-window'],
  probe: () => Promise.resolve({ ok: true }),
  launch: () => Promise.resolve({ ok: true }),
}

beforeEach(() => {
  vi.spyOn(process, 'kill').mockImplementation(() => true)
  const home = tempDir('ac-tele-place-')
  process.env.AGENT_CHAT_HOME = home
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(home, 'active-work')
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(home, 'events.db')),
    registry: new Registry<Conn>(),
  })
  stopAutoAttach = autoAttach(core)
  supervisor = new Supervisor(core, {
    countdownMs: 1000,
    hosts: launcher,
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

interface Case {
  host: string
  anchor?: string
  surface?: 'headless' | 'tmux-window'
  to?: string
}

async function placementFor({ host, anchor, surface, to }: Case): Promise<TeleportOutcome> {
  const agentId = await spawnScout()
  const conn = { write: () => undefined, end: () => undefined } as unknown as Conn
  const reply = core.register(conn, {
    t: 'register',
    name: 'scout',
    workingOn: 'w',
    cwd: tempDir('ac-ws-'),
    pid: 1,
    agentId,
    hostPid: 9999,
    host,
  })
  expect(reply.ok).toBe(true)
  return supervisor.teleport({
    subject: {
      agentId,
      name: 'scout',
      // A launcher destination checks paths under home; every other route checks they exist here.
      cwd: to === LAPTOP ? path.join(os.homedir(), 'projects', 'x') : tempDir('ac-ws-'),
      configDir: to === LAPTOP ? path.join(os.homedir(), '.claude-profiles', 'agents') : tempDir('ac-cfg-'),
      hostPid: 9999,
      host,
      ...(anchor === undefined ? {} : { anchor }),
      tags: [],
      subscriptions: [],
    },
    handoff: 'carry on',
    ...(surface === undefined ? {} : { surface }),
    ...(to === undefined ? {} : { to }),
    ...(host === os.hostname() ? {} : { hostPlatform: 'linux' as const, endsSelf: true }),
  })
}

describe('the placement a teleport reports', () => {
  it('is same-pane for a local session with an anchor and no surface asked for', async () => {
    expect(await placementFor({ host: os.hostname(), anchor: 'pane-1' })).toMatchObject({
      placement: 'same-pane',
    })
  })

  it('is new-surface for a local session that asked for a surface', async () => {
    const outcome = await placementFor({ host: os.hostname(), anchor: 'pane-1', surface: 'tmux-window' })

    expect(outcome).toMatchObject({ placement: 'new-surface' })
  })

  it('is same-pane for a remote session staying on its own host in its own pane', async () => {
    expect(await placementFor({ host: OTHER, anchor: 'pane-1' })).toMatchObject({ placement: 'same-pane' })
  })

  it('is other-machine for a remote session moving onto the broker host', async () => {
    const outcome = await placementFor({ host: OTHER, anchor: 'pane-1', to: os.hostname() })

    expect(outcome).toMatchObject({ placement: 'other-machine' })
  })

  it('is other-machine for a successor opened by a connected launcher', async () => {
    const outcome = await placementFor({
      host: os.hostname(),
      anchor: 'pane-1',
      surface: 'headless',
      to: LAPTOP,
    })

    expect(outcome).toMatchObject({ placement: 'other-machine' })
  })
})
