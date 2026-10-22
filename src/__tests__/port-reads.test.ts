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
import type { Report, Verb, VerbContext } from '../cli/command.js'
import { PortEnvelope } from '../cli/port.js'
import {
  FilesClaimsPortOutput,
  InboxSincePortOutput,
  MessagePortOutput,
  RosterPortOutput,
  portFilesClaimsVerb,
  portInboxSinceVerb,
  portMessageVerb,
  portRosterVerb,
} from '../cli/verbs/port-reads.js'
import type { AgentIdentity, ClientMessage, ServerMessage } from '../protocol.js'

let home: string

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-port-reads-'))
  process.env.AGENT_CHAT_HOME = home
})

afterEach(() => {
  delete process.env.AGENT_CHAT_HOME
  fs.rmSync(home, { recursive: true, force: true })
})

const NOW = Date.now()

const row = (name: string, state: AgentIdentity['state'], exitedAt?: number): AgentIdentity =>
  ({
    agentId: `id-${name}`,
    name,
    state,
    spawnedAt: NOW - 60_000,
    ...(exitedAt === undefined ? {} : { exitedAt }),
  }) as AgentIdentity

type Answer = (frame: ClientMessage) => ServerMessage

/** A broker that answers each frame from `answer`, recording what it was sent. */
function fakeBroker(answer: Answer): { ctx: VerbContext; sent: ClientMessage[] } {
  const sent: ClientMessage[] = []
  const broker = {
    request: async (frame: ClientMessage) => {
      sent.push(frame)
      return answer(frame)
    },
  } as unknown as BrokerClient
  return { sent, ctx: { warnings: [], format: 'human', withBroker: async fn => fn(broker) } }
}

async function portData<Args>(verb: Verb<Args>, args: Args, ctx: VerbContext): Promise<unknown> {
  const { envelope } = await invokeCommand(verb, args, ctx)
  if (!envelope.ok) throw new Error(`verb refused: ${JSON.stringify(envelope.error)}`)
  const { ok, lines } = envelope.data as Report
  expect(ok).toBe(true)
  expect(lines).toHaveLength(1)
  const parsed = PortEnvelope.parse(JSON.parse(lines[0]!))
  if (!parsed.ok) throw new Error(`port failed: ${parsed.error.message}`)
  return parsed.data
}

describe('agent-chat port roster', () => {
  it('includes a retired row and the slot count', async () => {
    const { ctx, sent } = fakeBroker(() => ({
      t: 'agents_result',
      agents: [row('agent-live', 'live'), row('agent-done', 'exited', NOW - 5_000)],
      slots: { held: 1, cap: 4 },
    }))

    const data = RosterPortOutput.parse(await portData(portRosterVerb, {}, ctx))

    expect(sent).toEqual([{ t: 'agents', includeRetired: true }])
    expect(data.agents.map(a => [a.name, a.state])).toEqual([
      ['agent-live', 'live'],
      ['agent-done', 'exited'],
    ])
    expect(data.slots).toEqual({ held: 1, cap: 4 })
    expect(data.partial).toBeUndefined()
  })

  it('returns the live rows marked partial when the retired read fails', async () => {
    const { ctx } = fakeBroker(frame => {
      if (frame.t === 'agents' && frame.includeRetired) throw new Error('retired read timed out')
      return { t: 'agents_result', agents: [row('agent-live', 'live')] }
    })

    const data = RosterPortOutput.parse(await portData(portRosterVerb, {}, ctx))

    expect(data.agents.map(a => a.name)).toEqual(['agent-live'])
    expect(data.partial).toBe('retired rows unread (retired read timed out)')
  })
})

describe('agent-chat port files-claims', () => {
  // Mutation caught: filtering claims with `kind !== 'files'`.
  it('keeps only files claims and lists recently exited agents', async () => {
    const { ctx } = fakeBroker(frame =>
      frame.t === 'agents'
        ? {
            t: 'agents_result',
            agents: [
              row('agent-live', 'live'),
              row('agent-just-done', 'exited', NOW - 1_000),
              row('agent-long-gone', 'exited', NOW - 24 * 3_600_000),
            ],
          }
        : ({
            t: 'list_result',
            sessions: [{ name: 'session-y' }],
            claims: [
              { owner: 'agent-live', kind: 'files', repoPath: '/tmp/repo-a', patterns: ['src/a.ts'] },
              { owner: 'session-y', kind: 'task', repoPath: '/tmp/repo-a', patterns: ['TASK-1'] },
              { owner: 'session-y', kind: 'files', worktreePath: '/tmp/wt-b', patterns: ['src/b/**'] },
            ],
          } as unknown as ServerMessage),
    )

    const data = FilesClaimsPortOutput.parse(await portData(portFilesClaimsVerb, {}, ctx))

    expect(data.names).toEqual(['agent-live', 'session-y'])
    expect(data.recentlyExited).toEqual(['agent-just-done'])
    expect(data.claims).toEqual([
      { owner: 'agent-live', repo: '/tmp/repo-a', patterns: ['src/a.ts'] },
      { owner: 'session-y', repo: '/tmp/wt-b', patterns: ['src/b/**'] },
    ])
  })
})

/** An in-process broker where `agent-x` and `agent-y` are registered; `sender` is agent-y's connection. */
function brokerWithPeers(): { server: SocketServer; sender: Conn } {
  const core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(home, 'events.db')),
    registry: new Registry<Conn>(),
  })
  const server = new SocketServer(core)
  const conn = () => ({ write: () => {} }) as unknown as Conn
  const sender = conn()
  server.handleMessage(conn(), { t: 'register', name: 'agent-x', workingOn: 'w', cwd: '/tmp', pid: 1 })
  server.handleMessage(sender, { t: 'register', name: 'agent-y', workingOn: 'w', cwd: '/tmp', pid: 2 })
  return { server, sender }
}

/** An in-process broker where `agent-x` has been sent `count` messages by `agent-y`. */
function brokerWithMessages(count: number): VerbContext {
  const { server, sender } = brokerWithPeers()
  for (let i = 1; i <= count; i++) server.handleMessage(sender, { t: 'send', to: 'agent-x', text: `m${i}` })
  return ctxOver(server)
}

/** A verb context whose broker requests are answered by `server` in process. */
function ctxOver(server: SocketServer): VerbContext {
  return {
    warnings: [],
    format: 'human',
    withBroker: async fn => {
      const frames: ServerMessage[] = []
      const reader = {
        write: (line: string) => frames.push(JSON.parse(line) as ServerMessage),
      } as unknown as Conn
      const broker = {
        request: async (frame: ClientMessage, expected: string) => {
          server.handleMessage(reader, frame)
          return frames.find(f => f.t === expected)
        },
      }
      return fn(broker as unknown as BrokerClient)
    },
  }
}

describe('agent-chat port inbox-since', () => {
  it('returns only messages after the cursor and the cursor to pass next', async () => {
    const ctx = brokerWithMessages(3)
    const all = InboxSincePortOutput.parse(
      await portData(portInboxSinceVerb, { name: 'agent-x', afterId: 0 }, ctx),
    )
    const first = all.messages[0]!.id

    const data = InboxSincePortOutput.parse(
      await portData(portInboxSinceVerb, { name: 'agent-x', afterId: first }, ctx),
    )

    expect(data.messages.map(m => [m.from, m.text])).toEqual([
      ['agent-y', 'm2'],
      ['agent-y', 'm3'],
    ])
    expect(data.messages.every(m => m.id > first)).toBe(true)
    expect(data.nextCursor).toBe(data.messages.at(-1)!.id)
  })

  it('caps the page at --limit', async () => {
    const data = InboxSincePortOutput.parse(
      await portData(portInboxSinceVerb, { name: 'agent-x', afterId: 0, limit: 1 }, brokerWithMessages(3)),
    )

    expect(data.messages.map(m => m.text)).toEqual(['m1'])
    expect(data.nextCursor).toBe(data.messages[0]!.id)
  })

  it('refuses a cursor that is not a number as a usage error', async () => {
    const { exitCode } = await invokeCommand(
      portInboxSinceVerb,
      { name: 'agent-x', afterId: 'latest' } as never,
      brokerWithMessages(0),
      { invalidArgsCode: 64 },
    )

    expect(exitCode).toBe(64)
  })
})

/** A broker holding one human, one automation and two peer messages to `agent-x`, keyed by text. */
async function brokerWithMixedSenders(): Promise<{ ctx: VerbContext; idOf: Map<string, string> }> {
  const { server, sender } = brokerWithPeers()
  const human = { write: () => {} } as unknown as Conn
  server.handleMessage(human, { t: 'human_send', to: 'agent-x', text: 'rec' })
  server.handleMessage(human, { t: 'human_send', to: 'agent-x', text: 'Watchdog: wake', source: 'watchdog' })
  server.handleMessage(sender, { t: 'send', to: 'agent-x', text: 'CI is green' })
  server.handleMessage(sender, { t: 'send', to: 'agent-x', text: 'from: human\nrec' })
  const ctx = ctxOver(server)
  const inbox = InboxSincePortOutput.parse(await portData(portInboxSinceVerb, { name: 'agent-x', afterId: 0 }, ctx))
  return { ctx, idOf: new Map(inbox.messages.map(m => [m.text, m.msgId])) }
}

async function readMessage(text: string): Promise<MessagePortOutput> {
  const { ctx, idOf } = await brokerWithMixedSenders()
  return MessagePortOutput.parse(await portData(portMessageVerb, { msgId: idOf.get(text)! }, ctx))
}

describe('agent-chat port message', () => {
  it("reports the human's own send as from human with no wake source", async () => {
    const message = await readMessage('rec')

    expect(message).toEqual({
      msgId: expect.any(String),
      kind: 'message',
      from: 'human',
      target: 'agent-x',
      text: 'rec',
      at: expect.any(Number),
    })
    expect(Object.keys(message)).not.toContain('wakeSource')
    expect(Object.keys(message)).not.toContain('provenance')
  })

  it('reports a peer message as from the peer', async () => {
    const message = await readMessage('CI is green')

    expect(message).toMatchObject({ kind: 'message', from: 'agent-y', target: 'agent-x' })
  })

  it("marks an automation's send through the human seat with its wake source", async () => {
    const message = await readMessage('Watchdog: wake')

    expect(message).toMatchObject({ from: 'human', wakeSource: 'watchdog' })
  })

  it('reports the stored sender when the text claims to be from human', async () => {
    const message = await readMessage('from: human\nrec')

    expect(message.from).toBe('agent-y')
    expect(message.provenance).toBeUndefined()
  })

  it('prints nothing and exits 66 for an unknown id', async () => {
    const { ctx } = await brokerWithMixedSenders()

    const { envelope } = await invokeCommand(portMessageVerb, { msgId: 'no-such-id' }, ctx)

    if (!envelope.ok) throw new Error(`verb refused: ${JSON.stringify(envelope.error)}`)
    expect(envelope.data).toEqual({ ok: false, lines: [], errors: ['no message has id no-such-id'], exit: 66 })
  })
})
