import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import { burndownSender, tickBroker } from '../cli/burndown-broker.js'
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
  closes: number
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
    const w = { conn, sent, received, closes: 0 } as Wire
    w.client = {
      request: async (frame: ClientMessage, expected: string) => {
        sent.push(frame)
        server.handleMessage(conn, frame)
        return received.findLast(f => f.t === expected)
      },
      close: () => {
        w.closes += 1
      },
    } as unknown as BrokerClient
    return w
  }
  return { core, wire }
}

const register = (w: Wire, name: string) =>
  w.client.request({ t: 'register', name, workingOn: 'x', cwd: home, pid: 1 }, 'register_result')

describe('burndownSender', () => {
  it('tells two seats over one burndown connection while the spawn connection stays unregistered', async () => {
    const { wire } = broker()
    const [seatT, seatU] = [wire(), wire()]
    await register(seatT, 'seat-t')
    await register(seatU, 'seat-u')
    const spawnConn = wire()
    const sender = wire()
    const opened = await tickBroker(
      spawnConn.client,
      burndownSender(async () => sender.client),
    ).seatSender()

    const replies = [await opened.send('seat-t', 'one'), await opened.send('seat-u', 'two')]
    opened.close()

    expect(replies).toEqual([{ ok: true }, { ok: true }])
    expect(sender.sent.map(f => f.t)).toEqual(['register', 'send', 'send'])
    expect(sender.sent[0]).toMatchObject({ name: 'burndown' })
    expect(sender.closes).toBe(1)
    expect(spawnConn.sent).toEqual([])
    expect(seatT.received.find(f => f.t === 'deliver')).toMatchObject({
      message: { from: 'burndown', text: 'one' },
    })
    expect(seatU.received.find(f => f.t === 'deliver')).toMatchObject({
      message: { from: 'burndown', text: 'two' },
    })
  })

  it('reports a refused registration on every send, without sending, and closes the connection', async () => {
    const { wire } = broker()
    await register(wire(), 'burndown')
    const sender = wire()

    const opened = await burndownSender(async () => sender.client)()
    const reply = await opened.send('seat-t', 'hello')

    expect(reply.ok).toBe(false)
    expect(reply.reason).toMatch(/^register as burndown: /)
    expect(sender.sent.map(f => f.t)).toEqual(['register'])
    expect(sender.closes).toBe(1)
  })
})
