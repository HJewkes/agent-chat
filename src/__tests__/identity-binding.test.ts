import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import type { Supervisor } from '../agents/supervisor.js'
import type { ClientMessage } from '../protocol.js'

/**
 * CC-1614: the registry records how a connection's agent id was bound, and the socket hands
 * that to the supervisor with every request that carries the requester's id. Every name,
 * session id and path here is synthetic.
 */

const SEAT = 'seat-alpha'
const SEAT_SESSION = 'session-seat-alpha'

let dir: string
let core: BrokerCore
let server: SocketServer

const newConn = (): Conn => ({ write: () => true }) as unknown as Conn

function register(name: string, ids: { sessionId?: string; agentId?: string } = {}): Conn {
  const conn = newConn()
  server.handleMessage(conn, { t: 'register', name, workingOn: 'testing', cwd: '/tmp', pid: 1, ...ids })
  return conn
}

/** An identity the broker launched under `name`, as its own `agent_spawned` row records it. */
function launched(name: string, sessionId: string): string {
  return core.append({
    kind: 'agent_spawned',
    actor: 'human',
    target: name,
    body: 'brief',
    meta: { origin: 'spawned', name, cwd: '/tmp', session_id: sessionId, profile: 'peer', depth: '1' },
  }).msgId
}

const supervisorOf = (): Supervisor => (server as unknown as { supervisor: Supervisor }).supervisor

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-identity-binding-'))
  process.env.AGENT_CHAT_HOME = dir
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
  })
  server = new SocketServer(core)
})

afterEach(() => {
  vi.restoreAllMocks()
  server.close()
  core.close()
  delete process.env.AGENT_CHAT_HOME
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('how a registration binds its agent id', () => {
  it('binds launch when the frame carries the id the broker launched under that name', () => {
    const agentId = launched(SEAT, SEAT_SESSION)

    const conn = register(SEAT, { agentId, sessionId: SEAT_SESSION })

    expect(core.registry.entryFor(conn)).toMatchObject({ agentId, binding: 'launch' })
  })

  // Catches: core.register passing 'launch' for every bound id.
  it('binds session when only an adopted identity’s session id is presented, under any name', () => {
    const first = register(SEAT, { sessionId: SEAT_SESSION })
    const agentId = core.registry.entryFor(first)?.agentId
    core.drop(first)

    const conn = register('not-the-seat', { sessionId: SEAT_SESSION })

    expect(core.registry.entryFor(conn)).toMatchObject({ agentId, binding: 'session' })
  })

  it('does not resolve a launched identity from its session id, so it mints a new adopted one', () => {
    const agentId = launched(SEAT, SEAT_SESSION)

    const conn = register('not-the-seat', { sessionId: SEAT_SESSION })

    const entry = core.registry.entryFor(conn)
    expect(entry?.agentId).not.toBe(agentId)
    expect(entry?.binding).toBe('adopted')
  })

  it('binds adopted when a new session is minted an identity', () => {
    const conn = register('hand-started', { sessionId: 'session-new' })

    const entry = core.registry.entryFor(conn)
    expect(entry?.agentId).toBeDefined()
    expect(entry?.binding).toBe('adopted')
  })

  it('binds session when an adopted session re-registers on a new connection', () => {
    const first = register('hand-started', { sessionId: 'session-new' })
    const agentId = core.registry.entryFor(first)?.agentId
    core.drop(first)

    const second = register('hand-started', { sessionId: 'session-new' })

    expect(core.registry.entryFor(second)).toMatchObject({ agentId, binding: 'session' })
  })

  it('records no binding for a registration with no identity at all', () => {
    const conn = register('no-session')

    const entry = core.registry.entryFor(conn)
    expect(entry?.agentId).toBeUndefined()
    expect(entry?.binding).toBeUndefined()
  })

  it('refuses a launch id presented under another name, so nothing is bound', () => {
    const agentId = launched(SEAT, SEAT_SESSION)

    const conn = register('renamed', { agentId })

    expect(core.registry.entryFor(conn)).toBeUndefined()
  })
})

describe('requests carry the requester binding', () => {
  it('passes requesterBinding with parentAgentId on a spawn', async () => {
    const agentId = launched(SEAT, SEAT_SESSION)
    const conn = register(SEAT, { agentId, sessionId: SEAT_SESSION })
    const spawn = vi.spyOn(supervisorOf(), 'spawn').mockResolvedValue({ ok: false, reason: 'stub' })

    server.handleMessage(conn, { t: 'spawn', name: 'child', profile: 'peer', brief: 'b' } as ClientMessage)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())

    expect(spawn.mock.calls[0]?.[0]).toMatchObject({ parentAgentId: agentId, requesterBinding: 'launch' })
  })

  it('passes a session binding on a spawn, never upgraded to launch', async () => {
    core.drop(register(SEAT, { sessionId: SEAT_SESSION }))
    const conn = register('not-the-seat', { sessionId: SEAT_SESSION })
    const spawn = vi.spyOn(supervisorOf(), 'spawn').mockResolvedValue({ ok: false, reason: 'stub' })

    server.handleMessage(conn, { t: 'spawn', name: 'child', profile: 'peer', brief: 'b' } as ClientMessage)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())

    expect(spawn.mock.calls[0]?.[0]).toMatchObject({ requesterBinding: 'session' })
  })

  it('passes no binding for the human at the CLI', async () => {
    const spawn = vi.spyOn(supervisorOf(), 'spawn').mockResolvedValue({ ok: false, reason: 'stub' })

    server.handleMessage(newConn(), {
      t: 'spawn',
      name: 'child',
      profile: 'peer',
      brief: 'b',
    } as ClientMessage)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())

    expect(spawn.mock.calls[0]?.[0]).not.toHaveProperty('requesterBinding')
  })

  it('passes requesterBinding with requesterAgentId on resume, surface and park', async () => {
    const conn = register('hand-started', { sessionId: 'session-new' })
    const agentId = core.registry.entryFor(conn)?.agentId
    const supervisor = supervisorOf()
    const resume = vi.spyOn(supervisor, 'resume').mockResolvedValue({ ok: false, reason: 'stub' })
    const surface = vi.spyOn(supervisor, 'switchSurface').mockResolvedValue({ ok: false, reason: 'stub' })
    const park = vi.spyOn(supervisor, 'park').mockResolvedValue({ ok: false, reason: 'stub' })

    server.handleMessage(conn, { t: 'resume', name: 'other' } as ClientMessage)
    server.handleMessage(conn, { t: 'surface', name: 'other' } as ClientMessage)
    server.handleMessage(conn, { t: 'park', name: 'other' } as ClientMessage)
    await vi.waitFor(() => expect(park).toHaveBeenCalled())
    await vi.waitFor(() => expect(resume).toHaveBeenCalled())
    await vi.waitFor(() => expect(surface).toHaveBeenCalled())

    const expected = { requesterAgentId: agentId, requesterBinding: 'adopted' }
    expect(resume.mock.calls[0]?.[1]).toMatchObject(expected)
    expect(surface.mock.calls[0]?.[0]).toMatchObject(expected)
    expect(park.mock.calls[0]?.[1]).toMatchObject(expected)
  })
})
