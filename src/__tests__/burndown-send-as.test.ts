import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import { sendAsBurndown, tickBroker } from '../cli/burndown-broker.js'
import type { BrokerClient } from '../client/broker-client.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'

/** CC-250: seat events leave through their own connection registered as `burndown`, as a peer `send`. */

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-send-as-'))
  process.env.AGENT_CHAT_HOME = home
})

afterEach(() => {
  delete process.env.AGENT_CHAT_HOME
  fs.rmSync(home, { recursive: true, force: true })
})

interface Wire {
  conn: Conn
  sent: ClientMessage[]
  received: ServerMessage[]
  client: BrokerClient
}

function broker() {
  const core = new BrokerCore(
    (conn, message) =>
      (conn as unknown as { write: (s: string) => void }).write(JSON.stringify({ t: 'deliver', message })),
    { events: new EventLog(path.join(home, 'events.db')), registry: new Registry<Conn>() },
  )
  const server = new SocketServer(core)
  const wire = (): Wire => {
    const received: ServerMessage[] = []
    const sent: ClientMessage[] = []
    const conn = {
      write: (line: string) => received.push(JSON.parse(line) as ServerMessage),
    } as unknown as Conn
    const client = {
      request: async (frame: ClientMessage, expected: string) => {
        sent.push(frame)
        server.handleMessage(conn, frame)
        return received.findLast(f => f.t === expected)
      },
      close: () => undefined,
    } as unknown as BrokerClient
    return { conn, sent, received, client }
  }
  return { core, wire }
}

describe('sendAsBurndown', () => {
  it('delivers a peer message from burndown while the spawn connection stays unregistered', async () => {
    const { wire } = broker()
    const seat = wire()
    await seat.client.request(
      { t: 'register', name: 'seat-t', workingOn: 'x', cwd: home, pid: 1 },
      'register_result',
    )
    const spawnConn = wire()
    const sender = wire()

    const reply = await tickBroker(
      spawnConn.client,
      sendAsBurndown(async () => sender.client),
    ).sendAs('seat-t', 'hello')

    expect(reply).toEqual({ ok: true })
    expect(sender.sent.map(f => f.t)).toEqual(['register', 'send'])
    expect(sender.sent[0]).toMatchObject({ name: 'burndown' })
    expect(spawnConn.sent).toEqual([])
    const delivered = seat.received.find(f => f.t === 'deliver')
    expect(delivered).toMatchObject({ message: { from: 'burndown', text: 'hello' } })
  })

  it('reports a refused registration without sending', async () => {
    const { wire } = broker()
    const squatter = wire()
    await squatter.client.request(
      { t: 'register', name: 'burndown', workingOn: 'x', cwd: home, pid: 1 },
      'register_result',
    )
    const sender = wire()

    const reply = await sendAsBurndown(async () => sender.client)('seat-t', 'hello')

    expect(reply.ok).toBe(false)
    expect(reply.reason).toMatch(/^register as burndown: /)
    expect(sender.sent.map(f => f.t)).toEqual(['register'])
  })
})
