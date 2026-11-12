import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerCore, type Conn } from '../broker/core.js'
import { deliver, SocketServer } from '../broker/socket.js'
import { EventLog } from '../broker/event-log.js'
import { Registry } from '../broker/registry.js'
import { BrokerClient } from '../client/broker-client.js'
import type { DeliveredMessage } from '../protocol.js'

/**
 * CC-1719: a remote teleport that never landed retires its predecessor while the
 * predecessor's session runs on under the name. A broker restart then made its
 * replayed registration bounce off the retirement, and the session was unreachable
 * until it restarted. Real clients over a real socket; the restart is a fresh core
 * reading the same event log, as the broker process does at start.
 */
const REMOTE_HOST = 'far-test-host'
const PREDECESSOR = 'a1b2c3d4'
const SUCCESSOR = 'e5f6a7b8'

let dir: string
let log: EventLog
let core: BrokerCore
let listener: net.Server | undefined
let serverConns: net.Socket[] = []
const clients: BrokerClient[] = []
const previousHome = process.env['AGENT_CHAT_HOME']

const settle = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function eventually(predicate: () => boolean): Promise<boolean> {
  for (let i = 0; i < 200 && !predicate(); i += 1) await settle(25)
  return predicate()
}

/** A broker process starting: a new core and registry over the log the last one wrote. */
async function startBroker(): Promise<void> {
  core = new BrokerCore(deliver, { events: log, registry: new Registry<Conn>() })
  const socketServer = new SocketServer(core)
  const server = net.createServer(conn => {
    serverConns.push(conn)
    socketServer.onConnection(conn)
  })
  listener = server
  await new Promise<void>(resolve => server.listen(path.join(dir, 'chat.sock'), resolve))
}

async function stopBroker(): Promise<void> {
  const server = listener
  listener = undefined
  for (const conn of serverConns.splice(0)) conn.destroy()
  if (server !== undefined) await new Promise<void>(resolve => server.close(() => resolve()))
}

async function client(name: string, agentId?: string, inbox: DeliveredMessage[] = []) {
  const created = new BrokerClient(message => void inbox.push(message))
  clients.push(created)
  await created.connect()
  const reply = await created.request(
    {
      t: 'register',
      name,
      workingOn: 'testing CC-1719',
      cwd: '/tmp',
      pid: 1,
      host: REMOTE_HOST,
      ...(agentId === undefined ? {} : { agentId }),
    },
    'register_result',
  )
  return { client: created, reply, inbox }
}

function spawnRow(agentId: string, teleportFrom?: string): void {
  core.append({
    kind: 'agent_spawned',
    actor: 'human',
    target: 'lead',
    msgId: agentId,
    body: 'coordinate',
    meta: {
      name: 'lead',
      profile: 'inherited',
      surface: 'iterm-tab',
      host: REMOTE_HOST,
      ...(teleportFrom === undefined ? {} : { teleport_from: teleportFrom }),
    },
  })
}

/** The rows a remote teleport writes when its name wait times out: the predecessor retires, connected. */
function teleportThatNeverLanded(): void {
  spawnRow(SUCCESSOR, PREDECESSOR)
  core.append({ kind: 'agent_stood_down', actor: 'lead', ref: PREDECESSOR })
  core.append({
    kind: 'agent_retired',
    actor: 'agent-chat',
    target: 'lead',
    ref: PREDECESSOR,
    body: 'superseded by teleport',
  })
}

/** The boot reaper's verdict on the successor that never connected. */
function exitInferredAtStart(): void {
  core.append({
    kind: 'agent_exited',
    actor: 'lead',
    ref: SUCCESSOR,
    body: 'exit inferred at broker start: no reconnect since the previous broker stopped',
    meta: { inferred: 'true' },
  })
}

/** The predecessor live on the bus after its teleport retired it, then the broker restarting under it. */
async function restartUnderStrandedPredecessor(): Promise<DeliveredMessage[]> {
  spawnRow(PREDECESSOR)
  const lead = await client('lead', PREDECESSOR)
  expect(lead.reply).toMatchObject({ ok: true })
  teleportThatNeverLanded()
  await stopBroker()
  exitInferredAtStart()
  await startBroker()
  expect(await eventually(() => core.registry.connFor('lead') !== undefined)).toBe(true)
  return lead.inbox
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac1719-'))
  process.env['AGENT_CHAT_HOME'] = dir
  log = new EventLog(path.join(dir, 'events.db'))
  vi.spyOn(
    BrokerClient.prototype as unknown as { spawnBroker: () => void },
    'spawnBroker',
  ).mockImplementation(() => undefined)
  await startBroker()
})

afterEach(async () => {
  for (const created of clients.splice(0)) created.close()
  vi.restoreAllMocks()
  await stopBroker()
  if (previousHome === undefined) delete process.env['AGENT_CHAT_HOME']
  else process.env['AGENT_CHAT_HOME'] = previousHome
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('a remote teleport predecessor still running when the broker restarts', () => {
  it('re-registers under its name on reconnect, and a peer send reaches it', async () => {
    const inbox = await restartUnderStrandedPredecessor()
    const peer = await client('peer')

    const sent = await peer.client.request({ t: 'send', to: 'lead', text: 'still there?' }, 'send_result')

    expect(sent).toMatchObject({ ok: true })
    expect(await eventually(() => inbox.some(m => m.text === 'still there?'))).toBe(true)
  })

  it('refuses an impostor the name, with or without an agent id', async () => {
    await restartUnderStrandedPredecessor()

    const ordinary = await client('lead')
    const asSuccessor = await client('lead', SUCCESSOR)
    const unknownId = await client('lead', 'ffffffff')

    expect(ordinary.reply).toMatchObject({ ok: false, reason: 'name "lead" is held by another session' })
    expect(asSuccessor.reply).toMatchObject({ ok: false, reason: 'name "lead" is held by another session' })
    expect(unknownId.reply).toMatchObject({ ok: false, reason: 'no agent with id ffffffff' })
  })

  it('stays refused once its successor has attached, since the name passed on', async () => {
    spawnRow(PREDECESSOR)
    teleportThatNeverLanded()
    core.append({ kind: 'agent_attached', actor: 'lead', ref: SUCCESSOR, body: 'landed' })
    core.append({ kind: 'agent_exited', actor: 'lead', ref: SUCCESSOR, meta: { inferred: 'true' } })

    const predecessor = await client('lead', PREDECESSOR)

    expect(predecessor.reply).toMatchObject({ ok: false, reason: `agent ${PREDECESSOR} has been retired` })
  })

  it('redoes a fixed-name registration on request once the broker has lost it', async () => {
    spawnRow(PREDECESSOR)
    const lead = await client('lead', PREDECESSOR)
    const conn = core.registry.connFor('lead') as Conn
    core.drop(conn)
    expect(core.registry.connFor('lead')).toBeUndefined()

    const replayed = await lead.client.replayRegistration()

    expect(replayed).toMatchObject({ ok: true })
    expect(core.registry.connFor('lead')).toBeDefined()
  })
})
