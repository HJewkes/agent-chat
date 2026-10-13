import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import type { BrokerClient } from '../client/broker-client.js'
import type { VerbContext } from '../cli/command.js'
import { PortEnvelope } from '../cli/port.js'
import { SendPortOutput, portSend } from '../cli/verbs/port-send.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'

let home: string
let server: SocketServer

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-port-send-'))
  process.env.AGENT_CHAT_HOME = home
  const core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(home, 'events.db')),
    registry: new Registry<Conn>(),
  })
  server = new SocketServer(core)
})

afterEach(() => {
  delete process.env.AGENT_CHAT_HOME
  fs.rmSync(home, { recursive: true, force: true })
})

const wire = () => {
  const frames: ServerMessage[] = []
  const conn = {
    write: (line: string) => frames.push(JSON.parse(line) as ServerMessage),
    end: () => undefined,
  }
  return { conn: conn as unknown as Conn, frames }
}

const registerAgent = (name: string) => {
  const peer = wire()
  server.handleMessage(peer.conn, { t: 'register', name, workingOn: 'w', cwd: '/tmp', pid: 1 })
  return peer
}

/** One persistent connection into the in-process broker, as the real client keeps for the whole call. */
function ctxOver(
  handle: (conn: Conn, frame: ClientMessage) => void = (conn, frame) => server.handleMessage(conn, frame),
): VerbContext {
  return {
    warnings: [],
    format: 'human',
    withBroker: async fn => {
      const mine = wire()
      const broker = {
        request: async (frame: ClientMessage, expected: string) => {
          handle(mine.conn, frame)
          return mine.frames.find(f => f.t === expected)
        },
        close: () => undefined,
      }
      return fn(broker as unknown as BrokerClient)
    },
  }
}

const inboxOf = (peer: ReturnType<typeof wire>) => {
  server.handleMessage(peer.conn, { t: 'inbox', limit: 10 })
  const result = peer.frames.find(f => f.t === 'inbox_result') as Extract<
    ServerMessage,
    { t: 'inbox_result' }
  >
  return result.messages
}

const stdin = (text: string) => async () => text

async function envelopeOf(args: Parameters<typeof portSend>[0], ctx: VerbContext, text = 'hello') {
  const report = await portSend(args, ctx, stdin(text))
  return { report, envelope: PortEnvelope.parse(JSON.parse(report.lines[0]!)) }
}

describe('agent-chat port send --as burndown', () => {
  // Mutation caught: sending on the unregistered connection, which makes `from` the human.
  it('delivers from burndown to the recipient', async () => {
    const recipient = registerAgent('agent-y')

    const { report, envelope } = await envelopeOf({ as: 'burndown', to: 'agent-y' }, ctxOver(), 'wake up')

    expect(report.ok).toBe(true)
    if (!envelope.ok) throw new Error('expected ok envelope')
    expect(SendPortOutput.parse(envelope.data)).toEqual({ sent: true })
    console.log(JSON.stringify(recipient.frames))
    expect(inboxOf(recipient).map(m => [m.from, m.text])).toEqual([['burndown', 'wake up']])
  })

  it('files a notice on the human queue with the task', async () => {
    const { envelope } = await envelopeOf(
      { as: 'burndown', notify: true, task: 'T-1' },
      ctxOver(),
      'gate open',
    )

    expect(envelope.ok).toBe(true)
    const human = wire()
    const queue: ClientMessage = { t: 'queue' }
    server.handleMessage(human.conn, queue)
    const result = human.frames.find(f => f.t === 'queue_result') as Extract<
      ServerMessage,
      { t: 'queue_result' }
    >
    expect(result.items.map(i => [i.from, i.text])).toEqual([['burndown', 'gate open']])
  })

  it('maps a refused register to register_refused', async () => {
    const ctx = ctxOver((conn, frame) => {
      if (frame.t === 'register') {
        ;(conn as unknown as { write(l: string): void }).write(
          JSON.stringify({ t: 'register_result', ok: false, reason: 'name is reserved' }),
        )
      }
    })

    const { report, envelope } = await envelopeOf({ as: 'burndown', to: 'agent-y' }, ctx)

    expect(report.ok).toBe(false)
    expect(envelope).toMatchObject({
      ok: false,
      error: {
        code: 'register_refused',
        retryable: false,
        message: expect.stringContaining('name is reserved'),
      },
    })
  })

  it('maps a recipient the broker does not know to send_refused', async () => {
    const { envelope } = await envelopeOf({ as: 'burndown', to: 'agent-nobody' }, ctxOver())

    expect(envelope).toMatchObject({ ok: false, error: { code: 'send_refused' } })
  })

  // CC-640: the frame was written and no reply came, so the broker may have routed it.
  it('reports a silent broker as unknown', async () => {
    registerAgent('agent-y')
    const ctx = ctxOver((conn, frame) => {
      if (frame.t === 'send') throw new Error('broker did not answer send_result')
      server.handleMessage(conn, frame)
    })

    const { envelope } = await envelopeOf({ as: 'burndown', to: 'agent-y' }, ctx)

    expect(envelope).toMatchObject({ ok: false, error: { code: 'broker_timeout', unknown: true } })
  })

  it.each([
    ['another sender', { as: 'human', to: 'agent-y' }],
    ['no recipient and no --notify', { as: 'burndown' }],
    ['a recipient with --notify', { as: 'burndown', to: 'agent-y', notify: true }],
    ['--task without --notify', { as: 'burndown', to: 'agent-y', task: 'T-1' }],
  ])('refuses %s as a usage error and sends nothing', async (_label, args) => {
    const frames: ClientMessage[] = []
    const ctx = ctxOver((_conn, frame) => void frames.push(frame))

    await expect(portSend(args, ctx, stdin('hello'))).rejects.toMatchObject({ code: 64 })

    expect(frames).toEqual([])
  })

  it('refuses an empty stdin as a usage error and sends nothing', async () => {
    const frames: ClientMessage[] = []
    const ctx = ctxOver((_conn, frame) => void frames.push(frame))

    await expect(portSend({ as: 'burndown', to: 'agent-y' }, ctx, stdin('  \n'))).rejects.toMatchObject({
      code: 64,
    })

    expect(frames).toEqual([])
  })

  // CC-1194 risk: a port send beside the live tick's own `burndown` connection. Observed: the broker
  // refuses the second registration and leaves the tick's connection alone.
  it('is refused as register_refused while a live registration holds the burndown name', async () => {
    const tick = registerAgent('burndown')
    const recipient = registerAgent('agent-y')
    const ticksRegistered = tick.frames.length

    const { envelope } = await envelopeOf({ as: 'burndown', to: 'agent-y' }, ctxOver())

    expect(envelope).toMatchObject({ ok: false, error: { code: 'register_refused', retryable: false } })
    expect(inboxOf(recipient)).toEqual([])
    expect(tick.frames).toHaveLength(ticksRegistered)
  })
})
