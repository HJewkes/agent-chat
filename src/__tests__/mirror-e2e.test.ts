import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { serve, type ServerType } from '@hono/node-server'
import { MemoryMirrorState, type MirrorState } from '@titan-design/queue-mirror'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { APPROVAL_TTL_MS, EventLog } from '../broker/event-log.js'
import { buildHttpApp } from '../broker/http.js'
import { Registry } from '../broker/registry.js'
import { deliver, SocketServer } from '../broker/socket.js'
import { BrokerClient } from '../client/broker-client.js'
import { lazyVerdicts, runMirrorLoop, unregisteredClient, type MirrorTuning } from '../mirror/run.js'
import { agentChatQueueSource } from '../mirror/source.js'
import { HUMAN, type DeliveredMessage, type ServerMessage } from '../protocol.js'
import { FakeMatrixHub } from './helpers/fake-matrix-hub.js'

/**
 * Offline end to end for CC-145 S2: a real in-process broker, the adapter,
 * queue-mirror's `runMirror` through `runMirrorLoop`, and a fake homeserver.
 * S3 repeats this live against the owner's phone; this is the part CI can hold.
 */

const OWNER = '@owner:example.org'
const MIRROR = '@ac-edge1:example.org'
const ROOM = '!queue:example.org'
const FAST: MirrorTuning = { sweepIntervalMs: 20, backoff: { initialMs: 10, maxMs: 50 } }

const shortTmp = (): string => (fs.existsSync('/tmp') ? '/tmp' : os.tmpdir())
const settle = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function eventually<T>(probe: () => T | undefined, what: string, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined && value !== false) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await settle(10)
  }
}

let dir: string
let core: BrokerCore
let socketServer: net.Server
let httpServer: ServerType
let port: number
let clients: BrokerClient[]
let hub: FakeMatrixHub
let stops: Array<() => Promise<void>>

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(shortTmp(), 'ac145e-'))
  process.env['AGENT_CHAT_HOME'] = dir
  clients = []
  stops = []
  hub = new FakeMatrixHub()
  core = new BrokerCore(deliver, {
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
  for (const stop of stops) await stop()
  for (const client of clients) client.close()
  ;(httpServer as unknown as { closeAllConnections: () => void }).closeAllConnections()
  await new Promise<void>(resolve => httpServer.close(() => resolve()))
  await new Promise<void>(resolve => socketServer.close(() => resolve()))
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Starts a mirror over `state`; the returned stop aborts it and waits for every loop to exit. */
async function startMirror(state: MirrorState, tuning: MirrorTuning = FAST): Promise<() => Promise<void>> {
  const verdicts = unregisteredClient()
  clients.push(verdicts)
  const source = agentChatQueueSource({
    machine: 'edge1',
    baseUrl: () => `http://127.0.0.1:${port}`,
    token: () => null,
    verdicts: lazyVerdicts(verdicts),
  })
  const controller = new AbortController()
  const silent = { info: () => undefined, warn: () => undefined }
  const running = runMirrorLoop({
    source,
    bus: hub.bus(MIRROR),
    state,
    ownerUserId: OWNER,
    roomId: ROOM,
    signal: controller.signal,
    logger: silent,
    tuning,
  })
  const stop = async () => {
    controller.abort()
    await running
  }
  stops.push(stop)
  await settle(50) // the SSE tail must be connected before the test appends anything
  return stop
}

async function asker(name: string): Promise<{ client: BrokerClient; delivered: DeliveredMessage[] }> {
  const delivered: DeliveredMessage[] = []
  const client = new BrokerClient(message => void delivered.push(message))
  await client.connect()
  clients.push(client)
  await client.request(
    { t: 'register', name, workingOn: 'CC-145 e2e', cwd: '/tmp', pid: process.pid },
    'register_result',
  )
  return { client, delivered }
}

async function ask(client: BrokerClient, text: string): Promise<string> {
  const res = (await client.request({ t: 'ask', text }, 'send_result')) as Extract<
    ServerMessage,
    { t: 'send_result' }
  >
  if (!res.ok || res.msgId === undefined) throw new Error(`ask refused: ${res.reason}`)
  return res.msgId
}

const posted = (msgId: string) => hub.items().find(item => item.record.msg_id === msgId)?.eventId

/** How many times the mirror asked the homeserver to post `msgId`, including deduped retries. */
const postSends = (msgId: string) =>
  hub.sends.filter(send => send.txnId === `qm-${encodeURIComponent(msgId)}`).length

describe('agent-chat mirror, offline end to end', () => {
  it('posts an ask once and routes the phone reply back to the asker', async () => {
    await startMirror(new MemoryMirrorState())
    const alice = await asker('alice')

    const msgId = await ask(alice.client, 'phone test 1')
    const eventId = await eventually(() => posted(msgId), 'the ask on the phone')
    hub.reply(OWNER, eventId, 'use option B')

    const answer = await eventually(() => alice.delivered.find(m => m.inReplyTo === msgId), 'the answer')
    expect(answer).toMatchObject({ from: HUMAN, text: 'use option B' })
    await eventually(() => hub.editsOf(eventId).includes('resolved: answer'), 'the phone edit')
    expect(postSends(msgId)).toBe(1)
  })

  it('edits the phone item when the terminal answers first', async () => {
    await startMirror(new MemoryMirrorState())
    const alice = await asker('alice')
    const terminal = unregisteredClient()
    clients.push(terminal)

    const msgId = await ask(alice.client, 'phone test 4')
    const eventId = await eventually(() => posted(msgId), 'the ask on the phone')
    await lazyVerdicts(terminal).request({ t: 'answer', msgId, text: 'done here' }, 'answer_result')

    await eventually(
      () => hub.editsOf(eventId).includes('resolved at the terminal: answered'),
      'the terminal-answer edit',
    )
  })

  it('loses nothing across a restart: a reply made while down folds once, and nothing reposts', async () => {
    const first = new MemoryMirrorState()
    const stopFirst = await startMirror(first)
    const alice = await asker('alice')
    const pending = await ask(alice.client, 'phone test 5a')
    const eventId = await eventually(() => posted(pending), 'the first ask on the phone')
    await stopFirst()

    hub.reply(OWNER, eventId, 'answered while the mirror was down')
    const fresh = await ask(alice.client, 'phone test 5b')
    await startMirror(MemoryMirrorState.restore(first.snapshot()))

    await eventually(() => posted(fresh), 'the ask made while the mirror was down')
    await eventually(() => alice.delivered.find(m => m.inReplyTo === pending), 'the reply made while down')
    await settle(100)
    expect(alice.delivered.filter(m => m.inReplyTo === pending)).toHaveLength(1)
    expect(postSends(pending)).toBe(1)
    expect(postSends(fresh)).toBe(1)
  })

  it('expires a relayed approval but never a hook approval, however old', async () => {
    const later = () => Date.now() + APPROVAL_TTL_MS + 60_000
    await startMirror(new MemoryMirrorState(), { ...FAST, now: later })
    const meta = { tool_name: 'Bash', input_preview: 'ls' }
    const relayed = core.append({ kind: 'approval_request', actor: 'bob', target: HUMAN, body: 'Bash', meta })
    const hook = core.append({
      kind: 'approval_request',
      actor: 'bob',
      target: HUMAN,
      body: 'Bash',
      meta: { ...meta, source: 'hook' },
    })

    const relayedEvent = await eventually(() => posted(relayed.msgId), 'the relayed approval')
    const hookEvent = await eventually(() => posted(hook.msgId), 'the hook approval')
    await eventually(() => hub.editsOf(relayedEvent).includes('expired'), 'the relayed approval expiring')
    await settle(100) // several more sweeps
    expect(hub.editsOf(hookEvent)).toEqual([])
  })
})
