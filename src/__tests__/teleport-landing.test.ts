import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { autoAttach } from './broker-harness.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor } from '../agents/supervisor.js'
import type { LauncherAnswer, LauncherSite } from '../agents/teleport.js'
import type { HostProbe, RemoteLaunch } from '../protocol.js'

/**
 * CC-1646 D1: a successor whose cwd is missing on the destination machine lands in the dir that
 * machine's launcher announced, and the cwd it left is recorded. The launcher is faked; no process
 * is launched or signalled, and every host, path and name here is synthetic.
 */

const MAC = 'mac-a.example'
const ORIGIN = path.join(os.homedir(), 'example-workspace', 'ws')
const LANDING = path.join(os.homedir(), 'agent-landing')
const CONFIG_DIR = path.join(os.homedir(), '.claude-profiles', 'agents')
const MISSING: LauncherAnswer = {
  ok: false,
  reason: `its cwd ${ORIGIN} is not a directory on this machine`,
  missing: 'cwd',
}

const tmpDirs: string[] = []
let core: BrokerCore
let supervisor: Supervisor
let stopAutoAttach: () => void
let probes: HostProbe[]
let launches: RemoteLaunch[]
let landing: string | undefined
let landingAnswer: LauncherAnswer
let originAnswer: LauncherAnswer

const tempDir = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

const launcher: LauncherSite = {
  launchers: () => [{ host: MAC, platform: 'darwin', proved: true }],
  surfacesOn: () => ['headless', 'iterm-window'],
  landingOn: () => landing,
  probe: (_host, probe) => {
    probes.push(probe)
    return Promise.resolve(probe.cwd === ORIGIN ? originAnswer : landingAnswer)
  },
  launch: (_host, launch) => {
    launches.push(launch)
    return Promise.resolve({ ok: true })
  },
}

function makeSupervisor(argv: string): void {
  supervisor = new Supervisor(core, {
    // An adopted coordinator's pane is visible, so it waits out the countdown first.
    countdownMs: 50,
    hosts: launcher,
    argvReader: () => argv,
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
}

beforeEach(() => {
  probes = []
  launches = []
  landing = LANDING
  landingAnswer = { ok: true }
  originAnswer = MISSING
  vi.spyOn(process, 'kill').mockImplementation(() => true)
  const home = tempDir('ac-tele-landing-')
  process.env.AGENT_CHAT_HOME = home
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ machines: { mac: MAC } }))
  process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = path.join(home, 'active-work')
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(home, 'events.db')),
    registry: new Registry<Conn>(),
  })
  stopAutoAttach = autoAttach(core)
  makeSupervisor('claude')
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

/** Registered and left connected, so the predecessor still holds its name when the probe returns. */
function connect(name: string, agentId?: string): string {
  const conn = { write: () => undefined, end: () => undefined } as unknown as Conn
  const reply = core.register(conn, {
    t: 'register',
    name,
    workingOn: 'w',
    cwd: tempDir('ac-ws-'),
    pid: 1,
    hostPid: 9999,
    host: os.hostname(),
    ...(agentId === undefined ? { sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e' } : { agentId }),
  })
  expect(reply.ok).toBe(true)
  return core.registry.entryFor(conn)?.agentId as string
}

async function spawnWorker(): Promise<string> {
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
  return connect('scout', result.agentId as string)
}

const teleportToMac = (agentId: string, name = 'scout') =>
  supervisor.teleport({
    subject: {
      agentId,
      name,
      cwd: ORIGIN,
      configDir: CONFIG_DIR,
      hostPid: 9999,
      host: os.hostname(),
      tags: [],
      subscriptions: [],
    },
    handoff: 'carry on',
    surface: 'headless',
    to: 'mac',
  })

const rows = () => core.events.since(0, 10_000)
const handoffMeta = () => rows().find(r => r.kind === 'agent_handoff')?.meta
const messagesTo = (name: string) =>
  rows().filter(r => r.kind === 'message' && r.target === name && r.actor === 'agent-chat')
/** The note goes out once the successor attaches, after the launch, so waiting on it lets the flow finish. */
const toldLanding = () => vi.waitFor(() => expect(messagesTo('scout')).toHaveLength(1))

describe('a teleport whose cwd is missing on the destination machine', () => {
  it("re-probes the launcher's landing dir and launches the successor there", async () => {
    const agentId = await spawnWorker()

    const result = await teleportToMac(agentId)
    await toldLanding()

    expect(result.ok).toBe(true)
    expect(probes.map(p => p.cwd)).toEqual([ORIGIN, LANDING])
    expect(probes[1]).toMatchObject({ configDir: CONFIG_DIR, surface: 'headless' })
    expect(launches[0]?.cwd).toBe(LANDING)
  })

  it('records the cwd it left on the handoff row', async () => {
    const result = await teleportToMac(await spawnWorker())
    await toldLanding()

    expect(result.ok).toBe(true)
    expect(handoffMeta()).toMatchObject({ origin_cwd: ORIGIN, landed_cwd: LANDING })
  })

  it('tells the successor where it landed and which cwd it left', async () => {
    await teleportToMac(await spawnWorker())

    await toldLanding()
    const body = messagesTo('scout')[0]?.body ?? ''
    expect(body).toContain(LANDING)
    expect(body).toContain(ORIGIN)
  })

  it('is refused unchanged when the launcher announced no landing dir', async () => {
    landing = undefined
    const agentId = await spawnWorker()

    const result = await teleportToMac(agentId)

    expect(result.ok).toBe(false)
    expect(result.reason).toContain(MISSING.reason)
    expect(probes).toHaveLength(1)
    expect(launches).toEqual([])
    expect(handoffMeta()).toBeUndefined()
  })

  it('is refused, naming both dirs, when the landing dir is refused too', async () => {
    landingAnswer = { ok: false, reason: `workspace trust prompt for ${LANDING}` }

    const result = await teleportToMac(await spawnWorker())

    expect(result.ok).toBe(false)
    expect(result.reason).toContain(ORIGIN)
    expect(result.reason).toContain(`workspace trust prompt for ${LANDING}`)
    expect(launches).toEqual([])
    expect(handoffMeta()).toBeUndefined()
  })

  it('keeps the cwd, and records no origin, when it exists on the destination', async () => {
    originAnswer = { ok: true }

    const result = await teleportToMac(await spawnWorker())
    await vi.waitFor(() => expect(launches).toHaveLength(1))

    expect(result.ok).toBe(true)
    expect(probes.map(p => p.cwd)).toEqual([ORIGIN])
    expect(launches[0]?.cwd).toBe(ORIGIN)
    expect(handoffMeta()).not.toHaveProperty('origin_cwd')
  })
})

describe('remote control across a launcher teleport', () => {
  const PRIMARY = 'claude --remote-control --channels plugin:agent-chat@agent-chat-local'

  beforeEach(() => {
    originAnswer = { ok: true }
  })

  it('carries it for a coordinator whose argv shows it', async () => {
    supervisor.close()
    makeSupervisor(PRIMARY)
    const agentId = connect('lead')

    expect((await teleportToMac(agentId, 'lead')).ok).toBe(true)
    await vi.waitFor(() => expect(launches).toHaveLength(1))

    expect(launches[0]?.remoteControl).toBe(true)
  })

  it("never carries it for a worker, even when the worker's argv shows it", async () => {
    supervisor.close()
    makeSupervisor(PRIMARY)

    expect((await teleportToMac(await spawnWorker())).ok).toBe(true)
    await vi.waitFor(() => expect(launches).toHaveLength(1))

    expect(launches[0]?.remoteControl).toBeUndefined()
  })
})
