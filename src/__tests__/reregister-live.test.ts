import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { SocketServer } from '../broker/socket.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { BrokerClient } from '../client/broker-client.js'

/**
 * CC-83 end to end: a real client, a real unix socket, and a registration the
 * broker drops while that socket stays open.
 *
 * The unit tests state that the broker EMITS the hint. This one is the reason the
 * task exists — it drives `BrokerClient` itself, which is where the bug lived and
 * which no amount of broker-side testing can reach. `onDrop` fires from close and
 * error handlers; the whole failure is that neither one happens here.
 *
 * A short socket directory, deliberately: a unix socket path is bounded (~104
 * bytes on darwin) and a long temp path fails as an opaque EINVAL at bind time.
 * `/tmp` rather than `os.tmpdir()`, which on darwin is a long `/var/folders/...`
 * path that blows that budget — and rather than `/private/tmp`, which is the
 * darwin spelling and does not exist on the Linux CI runner.
 */
const shortTmp = (): string => (fs.existsSync('/tmp') ? '/tmp' : os.tmpdir())

let dir: string
let server: net.Server | undefined
let core: BrokerCore
let client: BrokerClient | undefined
/** The broker's side of the client's connection, so a test can drop it. */
let serverConn: Conn | undefined
const previousHome = process.env['AGENT_CHAT_HOME']

const settle = (ms = 50): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Poll rather than sleep a fixed time: recovery is async and normally immediate. */
async function eventually(predicate: () => boolean, attempts = 60): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return true
    await settle(25)
  }
  return predicate()
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(shortTmp(), 'ac83-'))
  process.env['AGENT_CHAT_HOME'] = dir
  core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
  })
  const socketServer = new SocketServer(core)
  const listener = net.createServer(conn => {
    serverConn = conn
    socketServer.onConnection(conn)
  })
  server = listener
  await new Promise<void>(resolve => listener.listen(path.join(dir, 'chat.sock'), resolve))
})

afterEach(async () => {
  client?.close()
  client = undefined
  serverConn = undefined
  // Guarded: if setup failed before the listener existed, a teardown crash here
  // would replace that failure's cause with a confusing one about `close`.
  const listener = server
  server = undefined
  if (listener !== undefined) await new Promise<void>(resolve => listener.close(() => resolve()))
  if (previousHome === undefined) delete process.env['AGENT_CHAT_HOME']
  else process.env['AGENT_CHAT_HOME'] = previousHome
  fs.rmSync(dir, { recursive: true, force: true })
})

async function connectedClient(name: string): Promise<BrokerClient> {
  const created = new BrokerClient(() => undefined)
  await created.connect()
  await created.request(
    { t: 'register', name, workingOn: 'testing CC-83', cwd: '/tmp', pid: process.pid },
    'register_result',
  )
  return created
}

const registeredNames = (): string[] => core.registry.list().map(s => s.name)

describe('a registration dropped without the client seeing a close', () => {
  it('comes back on the next frame, with the socket never having closed', async () => {
    client = await connectedClient('voltras-bench')
    expect(registeredNames()).toEqual(['voltras-bench'])

    const socketBefore = serverConn
    core.registry.drop(serverConn as Conn)
    expect(registeredNames()).toEqual([])

    // The session tries to do something ordinary, exactly as it would have.
    await client.request({ t: 'send', to: 'nobody', text: 'still here?' }, 'send_result')

    expect(await eventually(() => registeredNames().includes('voltras-bench'))).toBe(true)
    // The same connection throughout: recovery must not depend on reconnecting,
    // because the socket was never the thing that broke.
    expect(serverConn).toBe(socketBefore)
    expect((socketBefore as unknown as net.Socket).destroyed).toBe(false)
  })

  it('restores the session for peers, which is what being dropped cost it', async () => {
    client = await connectedClient('voltras-bench')
    const peer = new BrokerClient(() => undefined)
    await peer.connect()
    await peer.request(
      { t: 'register', name: 'peer', workingOn: 'watching', cwd: '/tmp', pid: process.pid },
      'register_result',
    )

    const dropped = core.registry.connFor('voltras-bench')
    core.registry.drop(dropped as Conn)
    // A peer addressing it now gets nothing — the invisibility CC-83 is about.
    const missed = await peer.request({ t: 'send', to: 'voltras-bench', text: 'hi' }, 'send_result')
    expect(missed).toMatchObject({ t: 'send_result', ok: false })

    await client.request({ t: 'status', status: 'available' }, 'status_result')
    expect(await eventually(() => registeredNames().includes('voltras-bench'))).toBe(true)

    const landed = await peer.request({ t: 'send', to: 'voltras-bench', text: 'hi again' }, 'send_result')
    expect(landed).toMatchObject({ t: 'send_result', ok: true })
    peer.close()
  })

  it('does not stampede when several frames are refused at once', async () => {
    client = await connectedClient('voltras-bench')
    core.registry.drop(serverConn as Conn)

    // Each of these is refused and hints; only one registration may result, or
    // concurrent replays would race each other for the same name.
    await Promise.all([
      client.request({ t: 'send', to: 'a', text: '1' }, 'send_result'),
      client.request({ t: 'send', to: 'b', text: '2' }, 'send_result'),
      client.request({ t: 'send', to: 'c', text: '3' }, 'send_result'),
    ])

    expect(await eventually(() => registeredNames().includes('voltras-bench'))).toBe(true)
    expect(registeredNames().filter(n => n === 'voltras-bench')).toHaveLength(1)
  })
})

describe('a client with no identity', () => {
  it('ignores the hint, because the human at the CLI has nothing to replay', async () => {
    // Never registers — the shape of every `agent-chat` CLI invocation.
    const cli = new BrokerClient(() => undefined)
    await cli.connect()

    await cli.request({ t: 'send', to: 'anyone', text: 'hello' }, 'send_result')
    await settle(150)

    expect(registeredNames()).toEqual([])
    cli.close()
  })
})
