import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import { encode, type ClientMessage } from '../protocol.js'

/**
 * CC-1138 slice C: the broker records the agent id a connection's `hello` declares, and forgets
 * it with the connection. Nothing gates on it yet, so these pin the record, not a refusal.
 */

const tmpDirs: string[] = []
const servers: SocketServer[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function makeServer(): { core: BrokerCore; server: SocketServer } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-hello-'))
  tmpDirs.push(dir)
  const core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
  })
  const server = new SocketServer(core)
  servers.push(server)
  return { core, server }
}

/** A connection driven through `onConnection`, so a close runs the broker's real drop path. */
function connect(server: SocketServer): {
  conn: Conn
  send: (msg: ClientMessage) => void
  close: () => void
} {
  const emitter = new EventEmitter() as EventEmitter & { write: () => boolean }
  emitter.write = () => true
  const conn = emitter as unknown as Conn
  server.onConnection(conn)
  return {
    conn,
    send: msg => void emitter.emit('data', Buffer.from(encode(msg))),
    close: () => void emitter.emit('close'),
  }
}

const spawned = (core: BrokerCore, agentId: string, name: string): void =>
  void core.append({ kind: 'agent_spawned', actor: 'coord', target: name, msgId: agentId, body: 'work' })

describe('a connection that says hello', () => {
  it('reads as the declared agent while that agent is live', () => {
    const { core, server } = makeServer()
    spawned(core, 'a1', 'scout')
    const cli = connect(server)

    cli.send({ t: 'hello', agentId: 'a1' })

    expect(server.callerOf(cli.conn)).toEqual({ kind: 'declared', agentId: 'a1', name: 'scout' })
  })

  it('reads as an unknown declaration for an id with no identity', () => {
    const { server } = makeServer()
    const cli = connect(server)

    cli.send({ t: 'hello', agentId: 'nope' })

    expect(server.callerOf(cli.conn)).toEqual({ kind: 'declared', agentId: 'nope', unknown: true })
  })

  it('reads as unknown once the declared agent is retired', () => {
    const { core, server } = makeServer()
    spawned(core, 'a1', 'scout')
    const cli = connect(server)
    cli.send({ t: 'hello', agentId: 'a1' })

    core.append({ kind: 'agent_retired', actor: 'human', target: 'scout', ref: 'a1' })

    expect(server.callerOf(cli.conn)).toEqual({ kind: 'declared', agentId: 'a1', unknown: true })
  })

  // Mutation caught: leaving the record in place when the connection drops.
  it('reads as the human again after the connection closes', () => {
    const { core, server } = makeServer()
    spawned(core, 'a1', 'scout')
    const cli = connect(server)
    cli.send({ t: 'hello', agentId: 'a1' })

    cli.close()

    expect(server.callerOf(cli.conn)).toEqual({ kind: 'human' })
  })

  it('keeps its first declaration when a second hello names another agent', () => {
    const { core, server } = makeServer()
    spawned(core, 'a1', 'scout')
    spawned(core, 'a2', 'coord')
    const cli = connect(server)
    cli.send({ t: 'hello', agentId: 'a1' })

    cli.send({ t: 'hello', agentId: 'a2' })

    expect(server.callerOf(cli.conn)).toEqual({ kind: 'declared', agentId: 'a1', name: 'scout' })
  })

  it.each([
    ['blank', '   '],
    ['not a string', 7],
    ['too long', 'x'.repeat(129)],
  ])('declares nothing for an id that is %s', (_case, agentId) => {
    const { server } = makeServer()
    const cli = connect(server)

    cli.send({ t: 'hello', agentId } as unknown as ClientMessage)

    expect(server.callerOf(cli.conn)).toEqual({ kind: 'human' })
  })

  it('stays a session on a registered connection, whatever it declared', () => {
    const { core, server } = makeServer()
    spawned(core, 'a1', 'scout')
    const mcp = connect(server)
    mcp.send({ t: 'hello', agentId: 'a1' })

    mcp.send({ t: 'register', name: 'scout', agentId: 'a1', workingOn: 'testing', cwd: '/tmp', pid: 1 })

    expect(server.callerOf(mcp.conn)).toEqual({ kind: 'session' })
  })

  it('reads as the human without a hello, as every unregistered connection did before', () => {
    const { server } = makeServer()

    expect(server.callerOf(connect(server).conn)).toEqual({ kind: 'human' })
  })
})
