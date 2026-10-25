import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Supervisor } from '../agents/supervisor.js'
import { class2RequesterOf } from '../broker/class2-requester.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'

/**
 * CC-1138 slice E. An unregistered connection whose `hello` declared a live agent asks Class 2
 * frames as that agent, so a worker's own CLI is held to the worker rules its MCP connection is.
 * An unknown declared id is refused; a connection with no hello is still the human.
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
  server = new SocketServer(core, { surface: { platform: 'linux', spawn: liveChild } })
})

afterEach(() => {
  vi.restoreAllMocks()
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

/** A spawned agent's row; `exited` adds its exit, so nothing still runs it. */
function agent({ id, name, spawner = 'human', parent = '', role = 'worker' }: Row, exited = true): void {
  core.append({
    kind: 'agent_spawned',
    actor: spawner,
    target: name,
    msgId: id,
    body: 'synthetic brief',
    meta: { name, parent, role, profile: 'explorer', depth: '1', surface: 'headless' },
  })
  if (exited) core.append({ kind: 'agent_exited', actor: name, ref: id, body: '' })
}

function connection(): { conn: Conn; replies: ServerMessage[] } {
  const replies: ServerMessage[] = []
  const write = (chunk: string) => {
    for (const line of chunk.split('\n').filter(Boolean)) replies.push(JSON.parse(line) as ServerMessage)
    return true
  }
  return { conn: { write, end: () => undefined } as unknown as Conn, replies }
}

/** An agent's own shell: an unregistered connection that said hello with `agentId`. */
function declaredAs(agentId: string): { conn: Conn; replies: ServerMessage[] } {
  const link = connection()
  server.handleMessage(link.conn, { t: 'hello', agentId })
  return link
}

/** The live worker `wk` (id `wk-1`), spawned by the human, whose CLI declared itself. */
function declaredWorker(): { conn: Conn; replies: ServerMessage[] } {
  agent({ id: 'wk-1', name: 'wk' }, false)
  return declaredAs('wk-1')
}

async function ask<T extends ServerMessage['t']>(
  link: { conn: Conn; replies: ServerMessage[] },
  frame: ClientMessage,
  t: T,
) {
  server.handleMessage(link.conn, frame)
  return vi.waitFor(() => {
    const found = link.replies.find(r => r.t === t)
    if (found === undefined) throw new Error(`no ${t} yet`)
    return found as Extract<ServerMessage, { t: T }>
  })
}

const supervisorOf = () => (server as unknown as { supervisor: Supervisor }).supervisor
const stateOf = (id: string) => core.agents.get(id)?.state
const retiredRow = (id: string) =>
  core.events.agentEvents().find(row => row.kind === 'agent_retired' && row.ref === id)

function installCoordinatorProfile(name: string): void {
  const dir = path.join(process.env.AGENT_CHAT_HOME as string, 'profiles')
  fs.mkdirSync(dir, { recursive: true })
  const body = {
    model: 'opus',
    allowedTools: ['Read'],
    isolation: 'none',
    surface: 'headless',
    role: 'coordinator',
  }
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(body))
}

describe('Class 2 frames from a declared worker', () => {
  // Mutation caught: setting requestedBy alone, without parentAgentId, reads the worker as a root coordinator.
  it('refuses its spawn of a coordinator profile under the CC-163 worker ban', async () => {
    installCoordinatorProfile('lead')
    const worker = declaredWorker()

    const result = await ask(
      worker,
      {
        t: 'spawn',
        name: 'helper',
        profile: 'lead',
        brief: 'synthetic',
        cwd: tmp('agent-chat-ws-'),
        isolation: 'none',
      },
      'spawn_result',
    )

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/^wk is a worker \(profile explorer\) and cannot spawn agents/)
    expect(core.agents.byName('helper')).toBeUndefined()
  })

  it.each([
    ['resume', { t: 'resume', name: 'peer' }],
    ['park', { t: 'park', name: 'peer' }],
  ] as const)("refuses %s of a peer's agent through checkOwnership", async (verb, frame) => {
    agent({ id: 'peer-1', name: 'peer', spawner: 'lead', parent: 'lead-1' })
    const worker = declaredWorker()

    const result = await ask(worker, frame, 'spawn_result')

    expect(result.reason).toMatch(
      new RegExp(`wk is a worker \\(profile explorer\\) and can ${verb} only agents it spawned`),
    )
  })

  it("refuses surface of a peer's agent through checkOwnership", async () => {
    agent({ id: 'peer-1', name: 'peer', spawner: 'lead', parent: 'lead-1' })
    const worker = declaredWorker()

    const result = await ask(worker, { t: 'surface', name: 'peer' }, 'switch_result')

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(
      /wk is a worker \(profile explorer\) and can surface only agents it spawned/,
    )
  })

  it("retires none of a peer's agents on retire_finished", async () => {
    agent({ id: 'peer-1', name: 'peer', spawner: 'lead', parent: 'lead-1' })
    const worker = declaredWorker()

    const outcome = await ask(worker, { t: 'retire_finished', spawner: 'lead' }, 'retire_finished_result')

    expect(outcome.results).toEqual([])
    expect(outcome.plan[0]?.reason).toMatch(/wk is a worker .* can retire only agents it spawned/)
    expect(stateOf('peer-1')).toBe('exited')
  })

  it('retires its own agents on retire_finished with itself as the actor', async () => {
    const worker = declaredWorker()
    agent({ id: 'kid-1', name: 'kid', spawner: 'wk', parent: 'wk-1' })

    const outcome = await ask(worker, { t: 'retire_finished', spawner: 'wk' }, 'retire_finished_result')

    expect(outcome.results.map(r => [r.name, r.ok])).toEqual([['kid', true]])
    expect(retiredRow('kid-1')?.actor).toBe('wk')
  })

  it("refuses retire of a peer's agent", async () => {
    agent({ id: 'peer-1', name: 'peer', spawner: 'lead', parent: 'lead-1' })
    const worker = declaredWorker()

    const result = await ask(worker, { t: 'retire', name: 'peer' }, 'spawn_result')

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/wk is a worker .* can retire only agents it spawned/)
    expect(stateOf('peer-1')).toBe('exited')
  })

  it("records the declared name as retire's actor even when the frame says caller human", async () => {
    const worker = declaredWorker()
    agent({ id: 'kid-1', name: 'kid', spawner: 'wk', parent: 'wk-1' })

    const result = await ask(worker, { t: 'retire', name: 'kid', caller: 'human' }, 'spawn_result')

    expect(result.ok).toBe(true)
    expect(retiredRow('kid-1')?.actor).toBe('wk')
  })

  it('passes the declared id and a launch binding to the supervisor', async () => {
    const spawn = vi.spyOn(supervisorOf(), 'spawn').mockResolvedValue({ ok: false, reason: 'stubbed' })
    const worker = declaredWorker()

    await ask(worker, { t: 'spawn', name: 'helper', profile: 'explorer', brief: 'synthetic' }, 'spawn_result')

    expect(spawn.mock.calls[0]?.[0]).toMatchObject({
      requestedBy: 'wk',
      parentAgentId: 'wk-1',
      requesterBinding: 'launch',
    })
  })
})

const UNKNOWN: readonly (readonly [string, ClientMessage, ServerMessage['t']])[] = [
  ['spawn', { t: 'spawn', name: 'helper', profile: 'explorer', brief: 'synthetic' }, 'spawn_result'],
  ['resume', { t: 'resume', name: 'peer' }, 'spawn_result'],
  ['surface', { t: 'surface', name: 'peer' }, 'switch_result'],
  ['park', { t: 'park', name: 'peer' }, 'spawn_result'],
  ['retire_finished', { t: 'retire_finished', spawner: 'lead' }, 'retire_finished_result'],
  ['retire', { t: 'retire', name: 'peer', caller: 'human' }, 'spawn_result'],
]

describe('Class 2 frames from an unknown declared id', () => {
  it.each(UNKNOWN)('refuses %s from an id with no identity', async (_t, frame, t) => {
    agent({ id: 'peer-1', name: 'peer', spawner: 'lead', parent: 'lead-1' })

    const result = await ask(declaredAs('nobody-1'), frame, t)

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/nobody-1 .*names no live agent/),
    })
    expect(stateOf('peer-1')).toBe('exited')
  })

  it.each(UNKNOWN)('refuses %s from a retired agent', async (_t, frame, t) => {
    agent({ id: 'peer-1', name: 'peer', spawner: 'lead', parent: 'lead-1' })
    agent({ id: 'gone-1', name: 'gone' })
    core.append({ kind: 'agent_retired', actor: 'human', target: 'gone', ref: 'gone-1' })

    const result = await ask(declaredAs('gone-1'), frame, t)

    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/gone-1 .*names no live agent/) })
  })
})

describe('Class 2 frames with no hello', () => {
  it.each([
    ['spawn', { t: 'spawn', name: 'helper', profile: 'explorer', brief: 'synthetic' }, 'parentAgentId'],
    ['resume', { t: 'resume', name: 'peer' }, 'requesterAgentId'],
    ['park', { t: 'park', name: 'peer' }, 'requesterAgentId'],
  ] as const)('asks %s as the human, as before', async (verb, frame, idField) => {
    const method = vi.spyOn(supervisorOf(), verb).mockResolvedValue({ ok: false, reason: 'stubbed' })

    await ask(connection(), frame, 'spawn_result')

    const req = (method.mock.calls[0] as unknown[]).at(-1) as Record<string, unknown>
    expect(req.requestedBy).toBe('human')
    expect(req[idField]).toBeUndefined()
  })

  it('lets the human retire a peer agent with the frame caller as actor, as before', async () => {
    agent({ id: 'peer-1', name: 'peer', spawner: 'lead', parent: 'lead-1' })

    const result = await ask(connection(), { t: 'retire', name: 'peer', caller: 'coord-x' }, 'spawn_result')

    expect(result.ok).toBe(true)
    expect(retiredRow('peer-1')?.actor).toBe('coord-x')
  })
})

describe('class2RequesterOf', () => {
  const declared = { kind: 'declared', agentId: 'a1', name: 'scout' } as const

  it('gives a declared agent no binding when its id is not claimable under its name', () => {
    expect(class2RequesterOf(undefined, declared, () => false)).toEqual({ name: 'scout', agentId: 'a1' })
  })

  it('gives a claimable declared agent the launch binding', () => {
    expect(class2RequesterOf(undefined, declared, () => true)).toEqual({
      name: 'scout',
      agentId: 'a1',
      binding: 'launch',
    })
  })
})
