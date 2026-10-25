import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { SocketServer } from '../broker/socket.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'

/**
 * CC-1138 slice F. `retire` and `retire_finished` checked no ownership, so a registered
 * worker could retire a peer's agent. These drive the real socket handler, so the
 * requester's agent id comes from its own registered connection, and the ownership
 * test keys on the target's spawn row `meta.parent`, never the reusable spawner name.
 */

const tmpDirs: string[] = []
let realHome: string | undefined
let core: BrokerCore
let server: SocketServer

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

beforeEach(() => {
  realHome = process.env.HOME
  process.env.HOME = tmp('agent-chat-home-')
  const bus = tmp('agent-chat-bus-')
  process.env.AGENT_CHAT_HOME = bus
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(bus, 'events.db')),
    registry: new Registry<Conn>(),
  })
  server = new SocketServer(core, { surface: { platform: 'linux' } })
})

afterEach(() => {
  server.close()
  if (realHome === undefined) delete process.env.HOME
  else process.env.HOME = realHome
  delete process.env.AGENT_CHAT_HOME
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

interface Row {
  id: string
  name: string
  spawner?: string
  parent?: string
  role?: 'worker' | 'coordinator'
}

/** A finished spawned agent: its spawn row, then its exit, so nothing still runs it. */
function finished({ id, name, spawner = 'human', parent = '', role = 'worker' }: Row): void {
  core.append({
    kind: 'agent_spawned',
    actor: spawner,
    target: name,
    msgId: id,
    body: 'synthetic brief',
    meta: { name, parent, role, profile: 'explorer', depth: '1' },
  })
  core.append({ kind: 'agent_exited', actor: name, ref: id, body: '' })
}

/** A live spawned agent's own connection, registered under the id its spawn row was given. */
function registeredAs({ id, name, spawner = 'human', parent = '', role = 'worker' }: Row) {
  core.append({
    kind: 'agent_spawned',
    actor: spawner,
    target: name,
    msgId: id,
    body: 'synthetic brief',
    meta: { name, parent, role, profile: 'explorer', depth: '1' },
  })
  const link = connection()
  server.handleMessage(link.conn, {
    t: 'register',
    name,
    workingOn: 'synthetic work',
    cwd: tmp('agent-chat-ws-'),
    pid: 1,
    agentId: id,
  })
  return link
}

function connection(): { conn: Conn; replies: ServerMessage[] } {
  const replies: ServerMessage[] = []
  const write = (chunk: string) => {
    for (const line of chunk.split('\n').filter(Boolean)) replies.push(JSON.parse(line) as ServerMessage)
    return true
  }
  return { conn: { write, end: () => undefined } as unknown as Conn, replies }
}

async function replyOf<T extends ServerMessage['t']>(replies: ServerMessage[], t: T) {
  return vi.waitFor(() => {
    const found = replies.find(r => r.t === t)
    if (found === undefined) throw new Error(`no ${t} yet`)
    return found as Extract<ServerMessage, { t: T }>
  })
}

async function retireOver(link: { conn: Conn; replies: ServerMessage[] }, frame: ClientMessage) {
  server.handleMessage(link.conn, frame)
  return replyOf(link.replies, 'spawn_result')
}

const stateOf = (id: string) => core.agents.get(id)?.state
const retiredRow = (id: string) =>
  core.events.agentEvents().find(row => row.kind === 'agent_retired' && row.ref === id)

describe('retire asked for by a registered worker', () => {
  // Mutation caught: dropping the checkOwnership call from retireIdentity retires the stray.
  it('refuses an agent the worker did not spawn and leaves it unretired', async () => {
    finished({ id: 'stray-1', name: 'stray' })
    const worker = registeredAs({ id: 'wk-1', name: 'wk' })

    const result = await retireOver(worker, { t: 'retire', name: 'stray' })

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/wk is a worker \(profile explorer\) and can retire only agents it spawned/)
    expect(stateOf('stray-1')).toBe('exited')
  })

  it('retires an agent whose spawn row names the worker as parent', async () => {
    const worker = registeredAs({ id: 'wk-1', name: 'wk' })
    finished({ id: 'kid-1', name: 'kid', spawner: 'wk', parent: 'wk-1' })

    const result = await retireOver(worker, { t: 'retire', name: 'kid' })

    expect(result.ok).toBe(true)
    expect(retiredRow('kid-1')?.actor).toBe('wk')
  })

  // Mutation caught: comparing identity.spawnedBy with requestedBy lets the new holder of the name in.
  it('gives no ownership to a later agent that reuses the spawner name', async () => {
    finished({ id: 'boss-1', name: 'boss', role: 'coordinator' })
    finished({ id: 'kid-1', name: 'kid', spawner: 'boss', parent: 'boss-1' })
    const human = connection()
    expect((await retireOver(human, { t: 'retire', name: 'boss' })).ok).toBe(true)
    const successor = registeredAs({ id: 'boss-2', name: 'boss' })

    const result = await retireOver(successor, { t: 'retire', name: 'kid' })

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/can retire only agents it spawned/)
    expect(stateOf('kid-1')).toBe('exited')
  })

  // Mutation caught: dropping the claim from retireStale's call to retireById retires the stray.
  it('refuses the by-id form for an agent the worker did not spawn', async () => {
    finished({ id: 'stray-1', name: 'stray' })
    const worker = registeredAs({ id: 'wk-1', name: 'wk' })

    const result = await retireOver(worker, { t: 'retire', name: 'stray', agentId: 'stray-1' })

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/can retire only agents it spawned/)
    expect(stateOf('stray-1')).toBe('exited')
  })
})

describe('retire asked for by a coordinator or the human', () => {
  it('lets a registered coordinator retire an agent someone else spawned', async () => {
    finished({ id: 'stray-1', name: 'stray' })
    const lead = registeredAs({ id: 'lead-1', name: 'lead', role: 'coordinator' })

    const result = await retireOver(lead, { t: 'retire', name: 'stray' })

    expect(result.ok).toBe(true)
  })

  it('lets the unregistered human retire anything, as before', async () => {
    finished({ id: 'stray-1', name: 'stray', spawner: 'wk', parent: 'wk-1' })

    const result = await retireOver(connection(), { t: 'retire', name: 'stray', caller: 'coord-x' })

    expect(result.ok).toBe(true)
    expect(retiredRow('stray-1')?.actor).toBe('coord-x')
  })
})

describe('retire_finished asked for by a registered worker', () => {
  async function sweep(link: { conn: Conn; replies: ServerMessage[] }, frame: ClientMessage) {
    server.handleMessage(link.conn, frame)
    return replyOf(link.replies, 'retire_finished_result')
  }

  // Mutation caught: dropping the ownership port method plans and retires the other spawner's agents.
  it("retires none of another spawner's agents", async () => {
    finished({ id: 'other-1', name: 'other-a', spawner: 'lead', parent: 'lead-1' })
    finished({ id: 'other-2', name: 'other-b', spawner: 'lead', parent: 'lead-1' })
    const worker = registeredAs({ id: 'wk-1', name: 'wk' })

    const outcome = await sweep(worker, { t: 'retire_finished', spawner: 'lead' })

    expect(outcome.results).toEqual([])
    expect(outcome.plan.map(p => [p.name, p.action]).sort()).toEqual([
      ['other-a', 'skip'],
      ['other-b', 'skip'],
    ])
    expect(outcome.plan[0]?.reason).toMatch(/can retire only agents it spawned/)
    expect([stateOf('other-1'), stateOf('other-2')]).toEqual(['exited', 'exited'])
  })

  // Mutation caught: retireFinished's port calling retireById(agentId) without the caller writes actor human.
  it('retires its own agents with itself as the actor on each row', async () => {
    const worker = registeredAs({ id: 'wk-1', name: 'wk' })
    finished({ id: 'kid-1', name: 'kid-a', spawner: 'wk', parent: 'wk-1' })
    finished({ id: 'kid-2', name: 'kid-b', spawner: 'wk', parent: 'wk-1' })

    const outcome = await sweep(worker, { t: 'retire_finished', spawner: 'wk' })

    expect(outcome.results.map(r => [r.name, r.ok]).sort()).toEqual([
      ['kid-a', true],
      ['kid-b', true],
    ])
    expect([retiredRow('kid-1')?.actor, retiredRow('kid-2')?.actor]).toEqual(['wk', 'wk'])
  })

  // Mutation caught: spreading the frame's requester fields through lets a frame narrow the human.
  it('ignores requester fields carried in the frame itself', async () => {
    registeredAs({ id: 'wk-1', name: 'wk' })
    finished({ id: 'other-1', name: 'other-a', spawner: 'lead', parent: 'lead-1' })
    const frame = { t: 'retire_finished', spawner: 'lead', requesterAgentId: 'wk-1', caller: 'wk' }

    const outcome = await sweep(connection(), frame as unknown as ClientMessage)

    expect(outcome.results.map(r => [r.name, r.ok])).toEqual([['other-a', true]])
  })
})
