import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { serve, type ServerType } from '@hono/node-server'
import { ITEM_KINDS } from '@titan-design/matrix-bus'
import type { QueueItem } from '@titan-design/queue-mirror'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventFrameData } from '../api-contract.js'
import { BrokerCore, type Conn } from '../broker/core.js'
import { APPROVAL_TTL_MS, EventLog } from '../broker/event-log.js'
import { buildHttpApp } from '../broker/http.js'
import { Registry } from '../broker/registry.js'
import { SocketServer } from '../broker/socket.js'
import { BrokerClient } from '../client/broker-client.js'
import {
  agentChatQueueSource,
  toClientFrame,
  toQueueItem,
  toResolveResult,
  toSourceEvent,
  type AgentChatSourceOptions,
  type QueueRow,
} from '../mirror/source.js'
import { HUMAN, type ServerMessage } from '../protocol.js'

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(() => ({ unref: () => undefined })) }
})

const baseRow = (over: Partial<QueueRow> = {}): QueueRow => ({
  msgId: 'm1',
  kind: 'question',
  from: 'alice',
  text: 'blocked on what?',
  at: 1_000,
  meta: {},
  ...over,
})

describe('toQueueItem', () => {
  it.each(ITEM_KINDS)('maps a %s row, with the full body byte-equal', kind => {
    const big = 'x'.repeat(50_000)
    const item = toQueueItem(baseRow({ kind, text: big }), 'edge1')
    expect(item?.text).toBe(big)
  })

  it('carries recipient and agentId for an endorse_request', () => {
    const item = toQueueItem(
      baseRow({ kind: 'endorse_request', meta: { recipient: 'bob', agent_id: 'agent-9' } }),
      'edge1',
    )
    expect(item).toMatchObject({ recipient: 'bob', agentId: 'agent-9' })
  })

  it('gives a hook approval_request no expiresAt', () => {
    const item = toQueueItem(
      baseRow({ kind: 'approval_request', at: 1_000, meta: { source: 'hook', tool_name: 'Bash' } }),
      'edge1',
    )
    expect(item?.expiresAt).toBeUndefined()
  })

  it('gives a relayed approval_request at + APPROVAL_TTL_MS', () => {
    const item = toQueueItem(
      baseRow({ kind: 'approval_request', at: 1_000, meta: { tool_name: 'Bash' } }),
      'edge1',
    )
    expect(item?.expiresAt).toBe(1_000 + APPROVAL_TTL_MS)
  })

  it('gives null for a kind outside the five queue kinds', () => {
    expect(toQueueItem(baseRow({ kind: 'agent_spawned' }), 'edge1')).toBeNull()
  })
})

const baseFrame = (over: Partial<EventFrameData> = {}): EventFrameData => ({
  id: 5,
  ts: 1_000,
  kind: 'question',
  actor: 'alice',
  target: HUMAN,
  msgId: 'm5',
  ref: null,
  body: 'blocked on what?',
  meta: {},
  ...over,
})

describe('toSourceEvent', () => {
  it('gives an opened event for a queue row addressed to human', () => {
    const event = toSourceEvent(baseFrame(), 'edge1')
    expect(event).toEqual({
      type: 'opened',
      item: expect.objectContaining({ id: 'm5', kind: 'question', session: 'alice' }),
      cursor: '5',
    })
  })

  it('gives null for a question addressed to a named session, not human', () => {
    expect(toSourceEvent(baseFrame({ target: 'bob' }), 'edge1')).toBeNull()
  })

  it('maps a withdrawn resolution to cancelled', () => {
    const event = toSourceEvent(
      baseFrame({ id: 6, kind: 'resolution', ref: 'm5', body: 'withdrawn' }),
      'edge1',
    )
    expect(event).toEqual({ type: 'closed', id: 'm5', outcome: 'cancelled', label: 'withdrawn', cursor: '6' })
  })

  it('maps an answer to resolved, labelled answered rather than its body', () => {
    const event = toSourceEvent(baseFrame({ id: 7, kind: 'answer', ref: 'm5', body: 'here you go' }), 'edge1')
    expect(event).toEqual({ type: 'closed', id: 'm5', outcome: 'resolved', label: 'answered', cursor: '7' })
  })

  it('gives null for a row that is neither a queue kind nor a close', () => {
    expect(toSourceEvent(baseFrame({ kind: 'registered', target: null }), 'edge1')).toBeNull()
  })
})

describe('toClientFrame', () => {
  it('maps each verdict to its wire frame', () => {
    expect(toClientFrame('m1', { verdict: 'allow', resolutionEventId: 'r1' })).toEqual({
      t: 'approve_permission',
      msgId: 'm1',
      behavior: 'allow',
    })
    expect(toClientFrame('m1', { verdict: 'deny', resolutionEventId: 'r1' })).toEqual({
      t: 'approve_permission',
      msgId: 'm1',
      behavior: 'deny',
    })
    expect(toClientFrame('m1', { verdict: 'approve', resolutionEventId: 'r1' })).toEqual({
      t: 'endorse_approve',
      msgId: 'm1',
    })
    expect(toClientFrame('m1', { verdict: 'answer', text: 'hi', resolutionEventId: 'r1' })).toEqual({
      t: 'answer',
      msgId: 'm1',
      text: 'hi',
    })
    expect(toClientFrame('m1', { verdict: 'dismiss', resolutionEventId: 'r1' })).toEqual({
      t: 'dismiss',
      msgId: 'm1',
    })
  })
})

describe('toResolveResult', () => {
  const reply = (
    over: Partial<Extract<ServerMessage, { t: 'answer_result' }>>,
  ): Extract<ServerMessage, { t: 'answer_result' }> => ({ t: 'answer_result', ok: false, ...over })

  it('maps ok:true through unchanged', () => {
    expect(toResolveResult(reply({ ok: true }))).toEqual({ ok: true })
  })

  it('maps "is not an open item" to closed', () => {
    expect(toResolveResult(reply({ reason: 'm1 is not an open item' }))).toEqual({
      ok: false,
      reason: 'closed',
    })
  })

  it('maps "no item with id" to closed', () => {
    expect(toResolveResult(reply({ reason: 'no item with id m1' }))).toEqual({ ok: false, reason: 'closed' })
  })

  it('maps the isHuman refusal to rejected, with the detail attached', () => {
    const reason = 'answering is the human’s call; a session cannot answer on the human’s behalf'
    expect(toResolveResult(reply({ reason }))).toEqual({ ok: false, reason: 'rejected', detail: reason })
  })
})

function sseBody(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
}

interface FetchCall {
  url: string
  init: RequestInit | undefined
}

function fakeFetch(routes: Record<string, () => Response>): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const handler = routes[new URL(url).pathname]
    if (!handler) throw new Error(`no fake route for ${url}`)
    return handler()
  }) as unknown as typeof fetch
  return { fetch: impl, calls }
}

function baseOptions(over: Partial<AgentChatSourceOptions> = {}): AgentChatSourceOptions {
  return {
    machine: 'edge1',
    baseUrl: () => 'http://127.0.0.1:7600',
    token: () => null,
    verdicts: { request: async () => ({ t: 'answer_result', ok: true }) },
    ...over,
  }
}

describe('tail()', () => {
  it('connects before the first next(), not lazily on it', () => {
    const { fetch: fetchImpl, calls } = fakeFetch({ '/events': () => new Response(sseBody('')) })
    const source = agentChatQueueSource(baseOptions({ fetch: fetchImpl }))
    source.tail(undefined, new AbortController().signal)
    expect(calls).toHaveLength(1)
  })

  it('sends Last-Event-ID for a defined cursor', () => {
    const { fetch: fetchImpl, calls } = fakeFetch({ '/events': () => new Response(sseBody('')) })
    const source = agentChatQueueSource(baseOptions({ fetch: fetchImpl }))
    source.tail('41', new AbortController().signal)
    expect((calls[0]?.init?.headers as Record<string, string>)['Last-Event-ID']).toBe('41')
  })

  it('sends no Last-Event-ID header for an undefined cursor', () => {
    const { fetch: fetchImpl, calls } = fakeFetch({ '/events': () => new Response(sseBody('')) })
    const source = agentChatQueueSource(baseOptions({ fetch: fetchImpl }))
    source.tail(undefined, new AbortController().signal)
    expect(calls[0]?.init?.headers).not.toHaveProperty('Last-Event-ID')
  })

  it('reconciles from open() on a reset frame, then throws', async () => {
    const resetFrame = 'event: reset\ndata: {"reason":"gap_too_large","latestId":99}\n\n'
    const queueResponse = {
      items: [{ msgId: 'q1', kind: 'question', from: 'alice', text: 'hi', at: 1, meta: {} }],
    }
    const { fetch: fetchImpl } = fakeFetch({
      '/events': () => new Response(sseBody(resetFrame)),
      '/api/queue': () => new Response(JSON.stringify(queueResponse)),
    })
    const source = agentChatQueueSource(baseOptions({ fetch: fetchImpl }))
    const iterator = source.tail(undefined, new AbortController().signal)[Symbol.asyncIterator]()

    const opened = await iterator.next()
    expect(opened.value).toEqual({
      type: 'opened',
      item: expect.objectContaining({ id: 'q1' }),
      cursor: '99',
    })

    const closed = await iterator.next()
    expect(closed.value).toEqual({ type: 'closed', id: '__reset__', outcome: 'resolved', cursor: '99' })

    await expect(iterator.next()).rejects.toThrow('sse reset')
  })
})

describe('BrokerClient({ autoStart: false })', () => {
  const shortTmp = (): string => (fs.existsSync('/tmp') ? '/tmp' : os.tmpdir())

  it('rejects reaching an absent broker and never spawns one', async () => {
    const dir = fs.mkdtempSync(path.join(shortTmp(), 'ac145-'))
    const prevHome = process.env['AGENT_CHAT_HOME']
    process.env['AGENT_CHAT_HOME'] = dir
    try {
      const client = new BrokerClient(() => undefined, undefined, undefined, undefined, undefined, {
        autoStart: false,
      })
      const connecting = client.connect().catch(() => undefined)
      await new Promise(resolve => setTimeout(resolve, 150))
      client.close()
      await connecting
      expect(vi.mocked(spawn)).not.toHaveBeenCalled()
    } finally {
      if (prevHome === undefined) delete process.env['AGENT_CHAT_HOME']
      else process.env['AGENT_CHAT_HOME'] = prevHome
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * Contract test: the adapter against a real broker over a real unix socket and
 * a real loopback HTTP server (`http-routes.test.ts`'s in-process pattern, plus
 * a bound port so the adapter's own `fetch` can reach `/api/queue` and `/events`).
 */
describe('agentChatQueueSource, against a real in-process broker', () => {
  const shortTmp = (): string => (fs.existsSync('/tmp') ? '/tmp' : os.tmpdir())
  const settle = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

  let dir: string
  let core: BrokerCore
  let socketServer: net.Server
  let httpServer: ServerType
  let port: number
  let clients: BrokerClient[]

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(shortTmp(), 'ac145c-'))
    process.env['AGENT_CHAT_HOME'] = dir
    clients = []
    core = new BrokerCore(() => undefined, {
      events: new EventLog(path.join(dir, 'events.db')),
      registry: new Registry<Conn>(),
    })
    const server = new SocketServer(core)
    socketServer = net.createServer(conn => server.onConnection(conn))
    await new Promise<void>(resolve => socketServer.listen(path.join(dir, 'chat.sock'), resolve))
    const app = buildHttpApp({ core, port: () => port })
    port = await new Promise<number>(resolve => {
      httpServer = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, info => resolve(info.port))
    })
  })

  afterEach(async () => {
    for (const client of clients) client.close()
    await new Promise<void>(resolve => httpServer.close(() => resolve()))
    await new Promise<void>(resolve => socketServer.close(() => resolve()))
    fs.rmSync(dir, { recursive: true, force: true })
  })

  async function unregisteredClient(): Promise<BrokerClient> {
    const client = new BrokerClient(() => undefined)
    await client.connect()
    clients.push(client)
    return client
  }

  async function registeredClient(name: string): Promise<BrokerClient> {
    const client = await unregisteredClient()
    await client.request(
      { t: 'register', name, workingOn: 'CC-145 test', cwd: '/tmp', pid: process.pid },
      'register_result',
    )
    return client
  }

  function options(verdicts: AgentChatSourceOptions['verdicts']): AgentChatSourceOptions {
    return { machine: 'edge1', baseUrl: () => `http://127.0.0.1:${port}`, token: () => null, verdicts }
  }

  it('tails opened then closed events off a real broker, with increasing cursors', async () => {
    const source = agentChatQueueSource(options(await unregisteredClient()))
    const controller = new AbortController()
    const iterator = source.tail(undefined, controller.signal)[Symbol.asyncIterator]()
    await settle(50) // let the SSE connection establish before anything is appended

    const { msgId } = core.append({
      kind: 'question',
      actor: 'alice',
      target: HUMAN,
      body: 'blocked on what?',
    })
    const opened = await iterator.next()
    expect(opened.value).toMatchObject({ type: 'opened', item: { id: msgId, kind: 'question' } })

    core.dismiss(msgId)
    const closed = await iterator.next()
    expect(closed.value).toMatchObject({ type: 'closed', id: msgId, outcome: 'resolved' })
    expect(Number((closed.value as { cursor: string }).cursor)).toBeGreaterThan(
      Number((opened.value as { cursor: string }).cursor),
    )

    controller.abort()
  })

  it('resolves a dismiss over an unregistered connection', async () => {
    const source = agentChatQueueSource(options(await unregisteredClient()))
    const { msgId } = core.append({
      kind: 'question',
      actor: 'alice',
      target: HUMAN,
      body: 'blocked on what?',
    })

    const result = await source.resolve(msgId, { verdict: 'dismiss', resolutionEventId: 'r1' })
    expect(result).toEqual({ ok: true })
  })

  it('rejects endorse_approve once the verdict connection is registered', async () => {
    const composer = await registeredClient('composer')
    await registeredClient('recipient')
    const endorseReply = (await composer.request(
      { t: 'endorse', to: 'recipient', text: 'ship it' },
      'send_result',
    )) as Extract<ServerMessage, { t: 'send_result' }>
    const msgId = endorseReply.msgId
    expect(msgId).toBeDefined()

    const impersonator = await registeredClient('impersonator')
    const source = agentChatQueueSource(options(impersonator))
    const result = await source.resolve(msgId as string, { verdict: 'approve', resolutionEventId: 'r2' })
    expect(result).toEqual({ ok: false, reason: 'rejected', detail: expect.any(String) })
  })

  it('lists all five agent-chat queue kinds', () => {
    const source = agentChatQueueSource(options({ request: async () => ({ t: 'answer_result', ok: true }) }))
    expect([...source.kinds].sort()).toEqual(
      ['approval_request', 'endorse_request', 'message', 'notice', 'question'].sort(),
    )
  })
})
