import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import type { Supervisor } from '../agents/supervisor.js'
import { SocketServer } from '../broker/socket.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import type { ServerMessage } from '../protocol.js'
import { autoAttach } from './broker-harness.js'

/**
 * CC-225. `agent_surface` stops a headless agent and relaunches it in a pane,
 * and had no requester check. These drive the real socket handler, so the
 * requester's agent id comes from its own registered connection. `kill` is
 * stubbed: reaching it means the gate passed, and no real pid is signalled.
 */

const tmpDirs: string[] = []
let realHome: string | undefined
let core: BrokerCore
let server: SocketServer
let kill: ReturnType<typeof vi.spyOn>
let stopAutoAttach: () => void

const STUBBED = 'stubbed kill'

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

const liveChild = () => ({ pid: 4242, unref: () => undefined, once: () => undefined })

beforeEach(() => {
  realHome = process.env.HOME
  process.env.HOME = tmp('agent-chat-home-')
  const bus = tmp('agent-chat-bus-')
  process.env.AGENT_CHAT_HOME = bus
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(bus, 'events.db')),
    registry: new Registry<Conn>(),
  })
  stopAutoAttach = autoAttach(core)
  server = new SocketServer(core, { surface: { platform: 'linux', spawn: liveChild } })
  const supervisor = (server as unknown as { supervisor: Pick<Supervisor, 'kill'> }).supervisor
  kill = vi.spyOn(supervisor, 'kill').mockReturnValue({ ok: false, reason: STUBBED })
})

afterEach(() => {
  stopAutoAttach()
  server.close()
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function connection(): { conn: Conn; replies: ServerMessage[] } {
  const replies: ServerMessage[] = []
  const write = (chunk: string) => {
    for (const line of chunk.split('\n').filter(Boolean)) replies.push(JSON.parse(line) as ServerMessage)
    return true
  }
  return { conn: { write, end: () => undefined } as unknown as Conn, replies }
}

async function firstReply<T extends ServerMessage['t']>(replies: ServerMessage[], t: T) {
  return vi.waitFor(() => {
    const found = replies.find(r => r.t === t)
    if (found === undefined) throw new Error(`no ${t} yet`)
    return found as Extract<ServerMessage, { t: T }>
  })
}

/** A headless agent spawned over `conn`, which is the human's when unregistered. */
async function spawnOver(name: string, profile: string, over = connection()): Promise<string> {
  server.handleMessage(over.conn, {
    t: 'spawn',
    name,
    profile,
    brief: 'read the log',
    cwd: tmp('agent-chat-ws-'),
    isolation: 'none',
    surface: 'headless',
  })
  const result = await firstReply(over.replies, 'spawn_result')
  expect(result.ok).toBe(true)
  over.replies.length = 0
  return result.agentId as string
}

function registerAs(name: string, agentId: string): { conn: Conn; replies: ServerMessage[] } {
  const client = connection()
  server.handleMessage(client.conn, {
    t: 'register',
    name,
    workingOn: 'working',
    cwd: tmp('agent-chat-ws-'),
    pid: 1,
    agentId,
  })
  client.replies.length = 0
  return client
}

function writeLeadProfile(role?: string): void {
  const dir = path.join(process.env.AGENT_CHAT_HOME as string, 'profiles')
  fs.mkdirSync(dir, { recursive: true })
  const body = { model: 'opus', allowedTools: ['Read'], isolation: 'none', surface: 'headless' }
  fs.writeFileSync(path.join(dir, 'lead.json'), JSON.stringify(role ? { ...body, role } : body))
}

async function surface(client: { conn: Conn; replies: ServerMessage[] }, name: string) {
  server.handleMessage(client.conn, { t: 'surface', name })
  return firstReply(client.replies, 'switch_result')
}

describe('surface asked for over the socket', () => {
  it('refuses a registered worker surfacing an agent it did not spawn', async () => {
    await spawnOver('scout', 'explorer')
    const digger = registerAs('digger', await spawnOver('digger', 'explorer'))

    const result = await surface(digger, 'scout')

    expect(result.ok).toBe(false)
    expect(result.reason).toBe(
      'digger is a worker (profile explorer) and can surface only agents it spawned; scout was ' +
        'not. Report the need to your spawner via chat_send',
    )
    expect(kill).not.toHaveBeenCalled()
  })

  it('lets a worker surface an agent it spawned before it lost its coordinator role', async () => {
    writeLeadProfile('coordinator')
    const legacyRow = { name: 'lead', profile: 'lead' }
    const leadId = core.append({
      kind: 'agent_spawned',
      actor: 'human',
      target: 'lead',
      meta: legacyRow,
    }).msgId
    const lead = registerAs('lead', leadId)
    await spawnOver('scout', 'explorer', lead)
    writeLeadProfile()

    const result = await surface(lead, 'scout')

    expect(result.reason).toBe(STUBBED)
    expect(kill).toHaveBeenCalledWith('scout')
  })

  it('lets a worker surface itself', async () => {
    const digger = registerAs('digger', await spawnOver('digger', 'explorer'))

    const result = await surface(digger, 'digger')

    expect(result.reason).toBe(STUBBED)
  })

  it('lets a coordinator surface an agent it did not spawn', async () => {
    await spawnOver('scout', 'explorer')
    writeLeadProfile('coordinator')
    const lead = registerAs('lead', await spawnOver('lead', 'lead'))

    const result = await surface(lead, 'scout')

    expect(result.reason).toBe(STUBBED)
  })

  it('leaves the human at the CLI to the ordinary surface checks', async () => {
    await spawnOver('scout', 'explorer')

    const result = await surface(connection(), 'scout')

    expect(result.reason).toBe(STUBBED)
  })

  it('judges the requester by its connection, not by the frame', async () => {
    await spawnOver('scout', 'explorer')
    writeLeadProfile('coordinator')
    const leadId = await spawnOver('lead', 'lead')
    const digger = registerAs('digger', await spawnOver('digger', 'explorer'))

    server.handleMessage(digger.conn, {
      t: 'surface',
      name: 'scout',
      requesterAgentId: leadId,
      requestedBy: 'lead',
    } as never)
    const result = await firstReply(digger.replies, 'switch_result')

    expect(result.reason).toMatch(/^digger is a worker/)
  })
})
