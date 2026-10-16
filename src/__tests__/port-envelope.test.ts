import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { invokeCommand } from '@titan-design/registry'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import type { BrokerClient } from '../client/broker-client.js'
import { withBroker } from '../cli/client.js'
import type { Report, VerbContext } from '../cli/command.js'
import { PortEnvelope, PortRefusal, runPort } from '../cli/port.js'
import { QueuePortOutput, portQueueVerb } from '../cli/verbs/port-queue.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'
import { socketPath } from '../paths.js'

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-port-envelope-'))
  process.env.AGENT_CHAT_HOME = home
})

afterEach(() => {
  delete process.env.AGENT_CHAT_HOME
  fs.rmSync(home, { recursive: true, force: true })
})

const wire = () => {
  const frames: ServerMessage[] = []
  const conn = { write: (line: string) => frames.push(JSON.parse(line) as ServerMessage) } as unknown as Conn
  return { conn, frames }
}

/** An in-process broker holding two open human-queue items from a synthetic agent. */
function brokerWithTwoItems(): VerbContext {
  const core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(home, 'events.db')),
    registry: new Registry<Conn>(),
  })
  const server = new SocketServer(core)
  const asker = wire()
  server.handleMessage(asker.conn, { t: 'register', name: 'agent-x', workingOn: 'w', cwd: '/tmp', pid: 1 })
  server.handleMessage(asker.conn, {
    t: 'approval',
    requestId: 'r1',
    toolName: 'Bash',
    description: 'd',
    inputPreview: 'ls',
  })
  server.handleMessage(asker.conn, { t: 'ask', text: 'Which colour?', recommended: 'blue' })
  return {
    warnings: [],
    format: 'human',
    withBroker: async fn => {
      const human = wire()
      const broker = {
        request: async (frame: ClientMessage, expected: string) => {
          server.handleMessage(human.conn, frame)
          return human.frames.find(f => f.t === expected)
        },
      }
      return fn(broker as unknown as BrokerClient)
    },
  }
}

async function report(ctx: VerbContext): Promise<Report> {
  const { envelope } = await invokeCommand(portQueueVerb, {}, ctx)
  expect(envelope.ok).toBe(true)
  return (envelope as { data: Report }).data
}

const failingCtx = (err: Error): VerbContext => ({
  warnings: [],
  format: 'human',
  withBroker: async () => {
    throw err
  },
})

describe('agent-chat port queue', () => {
  it('prints one envelope line whose data parses as the queue output', async () => {
    const { ok, lines } = await report(brokerWithTwoItems())

    expect(ok).toBe(true)
    expect(lines).toHaveLength(1)
    const envelope = PortEnvelope.parse(JSON.parse(lines[0]!))
    if (!envelope.ok) throw new Error('expected ok envelope')
    const { items } = QueuePortOutput.parse(envelope.data)
    expect(items.map(i => [i.kind, i.from])).toEqual([
      ['approval_request', 'agent-x'],
      ['question', 'agent-x'],
    ])
  })

  // Mutation caught: dropping the forced probe, which brings autostart back and leaves a broker on the socket.
  it('exits 69 with broker_unavailable and starts no broker when none is listening', async () => {
    const ctx: VerbContext = { warnings: [], format: 'human', withBroker }

    const { ok, lines, errors, exit } = await report(ctx)

    expect(ok).toBe(false)
    expect(exit).toBe(69)
    const envelope = PortEnvelope.parse(JSON.parse(lines[0]!))
    expect(envelope).toMatchObject({ ok: false, error: { code: 'broker_unavailable', retryable: true } })
    expect(errors?.[0]).toMatch(/^broker unavailable/)
    expect(fs.existsSync(socketPath())).toBe(false)
  })

  it('maps a connect that fails after the probe passed to broker_unavailable', async () => {
    const { exit, lines } = await report(
      failingCtx(new Error('could not reach or start the agent-chat broker')),
    )

    expect(exit).toBe(69)
    expect(JSON.parse(lines[0]!)).toMatchObject({ error: { code: 'broker_unavailable' } })
  })
})

describe('runPort', () => {
  // Mutation caught: dropping retryAfterMs or retryable from the refusal mapping.
  it('passes a refusal code, retryable and retryAfterMs through', async () => {
    const refusal = new PortRefusal('broker_draining', 'draining for a restart', true, 30_000)

    const { ok, lines, exit } = await runPort(failingCtx(refusal), async () => undefined)

    expect(ok).toBe(false)
    expect(exit).toBe(1)
    expect(PortEnvelope.parse(JSON.parse(lines[0]!))).toEqual({
      ok: false,
      error: {
        code: 'broker_draining',
        message: 'draining for a restart',
        retryable: true,
        retryAfterMs: 30_000,
      },
    })
  })

  it('reports a write whose reply never came as broker_timeout with unknown set', async () => {
    const { lines } = await runPort(
      failingCtx(new Error('broker did not answer spawn_result')),
      async () => undefined,
    )

    expect(JSON.parse(lines[0]!)).toMatchObject({
      ok: false,
      error: { code: 'broker_timeout', unknown: true },
    })
  })

  it('asks the context for a connection that cannot autostart', async () => {
    const seen: unknown[] = []
    const ctx: VerbContext = {
      warnings: [],
      format: 'human',
      withBroker: async (fn, options) => {
        seen.push(options)
        return fn({} as BrokerClient)
      },
    }

    await runPort(ctx, async () => ({}))

    expect(seen).toEqual([{ autoStart: false }])
  })
})
