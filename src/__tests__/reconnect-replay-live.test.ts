import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { SocketServer } from '../broker/socket.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { BrokerClient } from '../client/broker-client.js'
import { ToolHandler } from '../server/tools.js'
import type { ClientMessage, ServerMessage } from '../protocol.js'

/**
 * CC-103: what a session's frames do while its broker is restarting.
 *
 * A real client and a real unix socket under an isolated AGENT_CHAT_HOME. The
 * "restart" closes the listener and the client's connection, then listens again
 * over the same core, so the client climbs its reconnect ladder for real. The
 * client's own broker autostart is stubbed: it would launch `dist/cli.js broker`
 * against this home and race the listener the test owns.
 *
 * Short socket directory for the reason `reregister-live.test.ts` gives.
 */
const shortTmp = (): string => (fs.existsSync('/tmp') ? '/tmp' : os.tmpdir())

let dir: string
let core: BrokerCore
let listener: net.Server | undefined
let serverConns: net.Socket[] = []
let seen: ClientMessage[] = []
let client: BrokerClient | undefined
const previousHome = process.env['AGENT_CHAT_HOME']

const settle = (ms = 50): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function eventually(predicate: () => boolean, attempts = 200): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return true
    await settle(25)
  }
  return predicate()
}

async function listen(): Promise<void> {
  const socketServer = new SocketServer(core)
  const handle = socketServer.handleMessage.bind(socketServer)
  socketServer.handleMessage = (conn, msg) => {
    seen.push(msg)
    handle(conn, msg)
  }
  const server = net.createServer(conn => {
    serverConns.push(conn)
    socketServer.onConnection(conn)
  })
  listener = server
  await new Promise<void>(resolve => server.listen(path.join(dir, 'chat.sock'), resolve))
}

/** Stop accepting and cut every live connection: the client sees a drop and cannot get back in. */
async function stopBroker(): Promise<void> {
  const server = listener
  listener = undefined
  for (const conn of serverConns.splice(0)) conn.destroy()
  if (server !== undefined) await new Promise<void>(resolve => server.close(() => resolve()))
  // Long enough for the client to see the close and start its ladder, short of the first 100 ms retry.
  await settle(20)
}

async function registeredClient(name: string, onDropped?: () => void): Promise<BrokerClient> {
  const created = new BrokerClient(() => undefined, undefined, undefined, undefined, onDropped)
  await created.connect()
  await created.request(
    { t: 'register', name, workingOn: 'testing CC-103', cwd: '/tmp', pid: 1 },
    'register_result',
  )
  return created
}

const statusOf = (name: string): string | undefined => core.registry.list().find(s => s.name === name)?.status

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(shortTmp(), 'ac103-'))
  process.env['AGENT_CHAT_HOME'] = dir
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
  })
  vi.spyOn(
    BrokerClient.prototype as unknown as { spawnBroker: () => void },
    'spawnBroker',
  ).mockImplementation(() => undefined)
  seen = []
  await listen()
})

afterEach(async () => {
  client?.close()
  client = undefined
  vi.restoreAllMocks()
  await stopBroker()
  if (previousHome === undefined) delete process.env['AGENT_CHAT_HOME']
  else process.env['AGENT_CHAT_HOME'] = previousHome
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('frames issued while the broker is restarting', () => {
  it('holds status and subscribe, then sends them after the reconnect re-registers', async () => {
    client = await registeredClient('worker')
    await stopBroker()

    const status = client.request(
      { t: 'status', status: 'working', workingOn: 'mid-restart' },
      'status_result',
    )
    const subscribe = client.request(
      { t: 'subscribe', subscriptions: [{ selector: { name: 'peer' }, kinds: ['registered'] }] },
      'subscribe_result',
    )
    await listen()

    expect(await status).toMatchObject({ t: 'status_result', ok: true })
    expect(await subscribe).toMatchObject({ t: 'subscribe_result', ok: true })
    expect(statusOf('worker')).toBe('working')
    const conn = core.registry.connFor('worker') as Conn
    expect(core.registry.subscriptionsOf(conn)).toEqual([
      { selector: { name: 'peer' }, kinds: ['registered'] },
    ])
    expect(seen.map(m => m.t).slice(-3)).toEqual(['register', 'status', 'subscribe'])
  })

  it('answers a register issued in the gap with the reconnect registration, sending it once', async () => {
    client = await registeredClient('worker')
    await stopBroker()
    seen = []

    const renamed = client.request(
      { t: 'register', name: 'worker-renamed', workingOn: 'renamed in the gap', cwd: '/tmp', pid: 1 },
      'register_result',
    )
    await listen()

    expect(await renamed).toMatchObject({ t: 'register_result', ok: true })
    expect(seen.filter(m => m.t === 'register')).toHaveLength(1)
    expect(core.registry.list().map(s => s.name)).toEqual(['worker-renamed'])
  })

  it('refuses send with a retryable error and never sends it, even once the broker is back', async () => {
    client = await registeredClient('worker')
    await stopBroker()

    const send = client.request({ t: 'send', to: 'peer', text: 'hello' }, 'send_result')

    await expect(send).rejects.toThrow(/broker restarting.*send was NOT sent; retry it within 9 s/)
    await listen()
    expect(await eventually(() => statusOf('worker') !== undefined)).toBe(true)
    await settle()
    expect(seen.filter(m => m.t === 'send')).toEqual([])
  })

  it('surfaces the restart in the chat_send tool result', async () => {
    client = await registeredClient('worker')
    await stopBroker()

    const result = new ToolHandler(client, 'worker').handle('chat_send', { to: 'peer', text: 'hello' })

    await expect(result).rejects.toThrow(/broker restarting.*retry it within 9 s/)
  })

  it('refuses a fire-and-forget approval in the gap rather than dropping it silently', async () => {
    // `onDropped` fires synchronously inside `onDrop`, before `reconnecting` flips
    // true but in the same turn — so awaiting it (rather than a fixed sleep) is
    // enough to guarantee `reconnecting` is already true once we proceed. A sleep
    // races the client's own close-event handling and was observed to let `send`
    // through to a half-dead socket on a loaded CI runner.
    let dropped: () => void = () => undefined
    const socketDown = new Promise<void>(resolve => {
      dropped = resolve
    })
    client = await registeredClient('worker', () => dropped())
    await stopBroker()
    await socketDown

    const approval = client.send({
      t: 'approval',
      requestId: 'r1',
      toolName: 'Bash',
      description: 'd',
      inputPreview: 'p',
    })

    await expect(approval).rejects.toThrow(/broker restarting.*approval was NOT sent/)
  })

  it('bounds what it holds and refuses the overflow as a restart', async () => {
    client = await registeredClient('worker')
    await stopBroker()

    const status = (): Promise<ServerMessage> | undefined =>
      client?.request({ t: 'status', status: 'available' }, 'status_result')
    const heldFrames = Array.from({ length: 32 }, status)
    const overflow = status()

    await expect(overflow).rejects.toThrow(/broker restarting.*status was NOT sent/)
    await listen()
    await expect(Promise.all(heldFrames)).resolves.toHaveLength(32)
  })

  it('drops what it holds on close and does not reconnect to send it', async () => {
    client = await registeredClient('worker')
    await stopBroker()
    seen = []
    const status = client.request({ t: 'status', status: 'working' }, 'status_result')

    client.close()
    await expect(status).rejects.toThrow('broker client closed')
    await listen()
    await settle(500)

    expect(serverConns).toEqual([])
    expect(seen).toEqual([])
  })
})
