import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type net from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { Supervisor, type SpawnRequest } from '../agents/supervisor.js'
import type { ProcessProbe } from '../agents/detached-reap.js'

/**
 * CC-1059 d: an agent launched on another host. The broker can probe neither its pid nor its
 * session records, so its exit is inferred from presence after the settle window, its slot comes
 * back, and retire asks its own process to end instead of signalling a pid that is not here.
 */

const CALLER = 'mac-test-host'
const MAC_CWD = `/Users/${os.userInfo().username}/projects/fantasy-football`
const SETTLE_MS = 40
const tmpDirs: string[] = []
let core: BrokerCore
let supervisor: Supervisor

const probe: ProcessProbe = {
  isAlive: () => {
    throw new Error('probed a local pid for a remote agent')
  },
  readArgv: () => {
    throw new Error('read a local argv for a remote agent')
  },
  sessionRecords: () => {
    throw new Error('read local session records for a remote agent')
  },
}

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

beforeEach(() => {
  process.env.HOME = tmp('agent-chat-home-')
  const home = tmp('agent-chat-bus-')
  process.env.AGENT_CHAT_HOME = home
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(home, 'events.db')),
    registry: new Registry<Conn>(),
  })
  supervisor = new Supervisor(core, {
    surface: {
      platform: 'linux',
      spawn: () => ({ pid: 4242, unref: () => undefined, once: () => undefined }),
    },
    settleMs: SETTLE_MS,
    processProbe: probe,
  })
})

afterEach(() => {
  supervisor.close()
  vi.restoreAllMocks()
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const remoteReq: SpawnRequest = {
  name: 'ff-planner',
  profile: 'peer',
  brief: 'plan the draft',
  requestedBy: 'human',
  cwd: MAC_CWD,
  surface: 'iterm-tab',
  callerHost: CALLER,
  hostPlatform: 'darwin',
  launchesHere: true,
}

const rows = (kind: string, agentId: string) =>
  core.events.agentEvents().filter(row => row.kind === kind && row.ref === agentId)
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Spawned, reported ready and placed, and registered from the remote host on `conn`. */
async function liveRemoteAgent(conn: Conn): Promise<string> {
  const outcome = await supervisor.spawn(remoteReq)
  const agentId = outcome.agentId as string
  expect(supervisor.remoteSpawnReady(agentId, { ok: true })).toEqual({ ok: true })
  const placed = supervisor.remoteSpawnPlaced(agentId, { ok: true })
  const registered = core.register(conn, {
    t: 'register',
    name: 'ff-planner',
    workingOn: 'planning',
    cwd: MAC_CWD,
    pid: 1,
    agentId,
    host: CALLER,
    hostPid: 777,
  })
  expect(registered.ok).toBe(true)
  expect(await placed).toMatchObject({ ok: true, agentId })
  return agentId
}

const fakeConn = (): Conn & { write: ReturnType<typeof vi.fn> } =>
  ({ write: vi.fn(() => true) }) as unknown as net.Socket & { write: ReturnType<typeof vi.fn> }

describe('an agent running on another host', () => {
  it('is recorded exited after the settle window, naming its host, and gives its slot back', async () => {
    const agentId = await liveRemoteAgent(fakeConn())
    expect(supervisor.slotIds()).toEqual([agentId])

    core.append({ kind: 'agent_detached', actor: 'ff-planner', ref: agentId })
    await pause(SETTLE_MS * 3)

    const exited = rows('agent_exited', agentId)
    expect(exited).toHaveLength(1)
    expect(exited[0]?.meta.inferred).toBe('true')
    expect(exited[0]?.body).toContain(`on host ${CALLER}`)
    expect(supervisor.slotIds()).toEqual([])
  })

  it('keeps its row and its slot when it reattaches inside the settle window', async () => {
    const agentId = await liveRemoteAgent(fakeConn())

    core.append({ kind: 'agent_detached', actor: 'ff-planner', ref: agentId })
    await pause(SETTLE_MS / 4)
    core.append({ kind: 'agent_attached', actor: 'ff-planner', ref: agentId })
    await pause(SETTLE_MS * 3)

    expect(rows('agent_exited', agentId)).toHaveLength(0)
    expect(core.agents.get(agentId)?.state).toBe('live')
    expect(supervisor.slotIds()).toEqual([agentId])
  })

  it('returns to live when it reattaches after an inferred exit', async () => {
    const agentId = await liveRemoteAgent(fakeConn())

    core.append({ kind: 'agent_detached', actor: 'ff-planner', ref: agentId })
    await pause(SETTLE_MS * 3)
    core.append({ kind: 'agent_attached', actor: 'ff-planner', ref: agentId })

    expect(core.agents.get(agentId)?.state).toBe('live')
    expect(supervisor.slotIds()).toEqual([agentId])
  })

  it('is asked to end through its own connection on retire, never signalled by pid', async () => {
    const conn = fakeConn()
    const agentId = await liveRemoteAgent(conn)
    const kill = vi.spyOn(process, 'kill')

    const result = await supervisor.retire('ff-planner')

    expect(result.ok).toBe(true)
    expect(result.reason).toContain(`runs on ${CALLER}`)
    expect(kill).not.toHaveBeenCalled()
    const frames = conn.write.mock.calls.map(([line]) => JSON.parse(String(line)) as { t: string })
    expect(frames).toContainEqual(expect.objectContaining({ t: 'end_self', agentId }))
    expect(rows('agent_retired', agentId)[0]?.meta.reaped).toBe('remote_end_requested')
    expect(supervisor.slotIds()).toEqual([])
  })

  it('stays retired with no exit row and no slot when its connection closes after retire', async () => {
    const agentId = await liveRemoteAgent(fakeConn())
    const result = await supervisor.retire('ff-planner')

    core.append({ kind: 'agent_detached', actor: 'ff-planner', ref: agentId })
    await pause(SETTLE_MS * 3)

    expect(result.reason).toContain('Nothing confirms that it ended')
    expect(rows('agent_exited', agentId)).toHaveLength(0)
    expect(core.agents.get(agentId)?.state).toBe('retired')
    expect(supervisor.slotIds()).toEqual([])
  })
})
