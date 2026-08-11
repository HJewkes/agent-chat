import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { SocketServer } from '../broker/socket.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'

/**
 * CC-83 — the broker tells a connection it does not know, so the client can
 * register again without the session restarting.
 *
 * THE BUG. `BrokerClient.onDrop()` replays the identity, but it fires only from
 * the socket's own close/error handlers. A registration the BROKER dropped while
 * the client's socket stayed up leaves `onDrop` unfired and the session invisible
 * to every peer while looking healthy from inside. Observed live on 2026-08-11:
 * voltras-bench deregistered at 06:39:12, its MCP subprocess still connected, and
 * it never came back.
 *
 * THE THING THAT MAKES THIS DELICATE, and what most of these tests are about: an
 * unregistered connection is ALSO the normal shape of the human at the CLI —
 * `isHuman` is defined as having no name. So the hint must key on which frame was
 * sent, not merely on the connection being unknown.
 */

const tmpDirs: string[] = []

interface Wire {
  conn: Conn
  frames: ServerMessage[]
}

function makeServer(): { core: BrokerCore; server: SocketServer; wire: () => Wire } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-cc83-'))
  tmpDirs.push(dir)
  const core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
  })
  const server = new SocketServer(core)
  const wire = (): Wire => {
    const frames: ServerMessage[] = []
    const conn = {
      write: (line: string) => frames.push(JSON.parse(line) as ServerMessage),
    } as unknown as Conn
    return { conn, frames }
  }
  return { core, server, wire }
}

/** Every `not_registered` hint among what the broker wrote back. */
const hints = (frames: ServerMessage[]): Extract<ServerMessage, { t: 'error' }>[] =>
  frames.filter(
    (f): f is Extract<ServerMessage, { t: 'error' }> => f.t === 'error' && f.code === 'not_registered',
  )

const register = (server: SocketServer, conn: Conn, name: string): void =>
  server.handleMessage(conn, { t: 'register', name, workingOn: 'testing', cwd: '/tmp', pid: 1 })

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('the not_registered hint', () => {
  it('answers a session frame from a connection the broker does not know', () => {
    const { server, wire } = makeServer()
    const { conn, frames } = wire()

    server.handleMessage(conn, { t: 'send', to: 'someone', text: 'hello' })

    expect(hints(frames)).toHaveLength(1)
    expect(hints(frames)[0]?.reason).toContain('no registration for this connection')
  })

  it('sends the hint ALONGSIDE the ordinary refusal, not instead of it', () => {
    const { server, wire } = makeServer()
    const { conn, frames } = wire()

    server.handleMessage(conn, { t: 'send', to: 'someone', text: 'hello' })

    // The pending request still has to get its answer: the hint is advice to the
    // client library, and a caller waiting on send_result must not hang for it.
    const results = frames.filter(f => f.t === 'send_result')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ ok: false })
    expect(hints(frames)).toHaveLength(1)
  })

  it('is never fatal, because the point is to recover rather than to stop', () => {
    const { server, wire } = makeServer()
    const { conn, frames } = wire()

    server.handleMessage(conn, { t: 'status', status: 'available' })

    expect(hints(frames)[0]?.fatal).toBeUndefined()
  })

  it('costs a healthy session nothing', () => {
    const { server, wire } = makeServer()
    const { conn, frames } = wire()
    register(server, conn, 'alpha')

    server.handleMessage(conn, { t: 'status', status: 'working' })
    server.handleMessage(conn, { t: 'send', to: 'nobody', text: 'hi' })
    server.handleMessage(conn, { t: 'broadcast', text: 'hi all' })

    expect(hints(frames)).toHaveLength(0)
  })
})

describe('the human at the CLI, who never registers', () => {
  /**
   * The regression this guards is a real one waiting to happen: the obvious
   * implementation is "unknown connection -> hint", and `isHuman` means every
   * ordinary CLI command arrives on an unknown connection.
   */
  it.each<ClientMessage>([
    { t: 'human_send', to: 'alpha', text: 'from the human' },
    { t: 'answer', msgId: 'abc12345', text: 'yes' },
    { t: 'dismiss', msgId: 'abc12345' },
    { t: 'queue' },
    { t: 'list' },
  ])('is not told to register when it sends $t', frame => {
    const { server, wire } = makeServer()
    const { conn, frames } = wire()

    server.handleMessage(conn, frame)

    expect(hints(frames)).toHaveLength(0)
  })
})

describe('the CC-83 scenario itself', () => {
  it('hints once the broker has dropped a registration the client never saw close', () => {
    const { core, server, wire } = makeServer()
    const { conn, frames } = wire()
    register(server, conn, 'voltras-bench')

    // Exactly what happened live: the registration goes away while the connection
    // stays up and usable. The client has no close event to react to.
    core.registry.drop(conn)
    expect(core.registry.nameOf(conn)).toBeUndefined()

    server.handleMessage(conn, { t: 'send', to: 'someone', text: 'still here?' })

    expect(hints(frames)).toHaveLength(1)
  })

  it('lets the same connection register again and become visible', () => {
    const { core, server, wire } = makeServer()
    const { conn } = wire()
    register(server, conn, 'voltras-bench')
    core.registry.drop(conn)
    expect(core.registry.list()).toHaveLength(0)

    // What BrokerClient.reregister() does on the hint: replay the identity onto
    // the connection it already has. No new socket, no restarted session.
    register(server, conn, 'voltras-bench')

    expect(core.registry.list().map(s => s.name)).toEqual(['voltras-bench'])
  })
})
