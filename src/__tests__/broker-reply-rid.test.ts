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
import { encode, lineReader, type ClientMessage, type Correlated, type ServerMessage } from '../protocol.js'

/**
 * CC-1343 on a real broker and socket: a request's id comes back on its reply, so
 * the client can match by id instead of guessing whether a reply was late or lost.
 */

let dir: string
let server: net.Server | undefined
let raw: net.Socket | undefined
let client: BrokerClient | undefined
const previousHome = process.env['AGENT_CHAT_HOME']

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac1343r-'))
  process.env['AGENT_CHAT_HOME'] = dir
  const core = new BrokerCore(() => undefined, {
    events: new EventLog(path.join(dir, 'events.db')),
    registry: new Registry<Conn>(),
  })
  const socketServer = new SocketServer(core)
  const listener = net.createServer(conn => socketServer.onConnection(conn))
  server = listener
  await new Promise<void>(resolve => listener.listen(path.join(dir, 'chat.sock'), resolve))
})

afterEach(async () => {
  client?.close()
  client = undefined
  raw?.destroy()
  raw = undefined
  const listener = server
  server = undefined
  if (listener) await new Promise<void>(resolve => listener.close(() => resolve()))
  if (previousHome === undefined) delete process.env['AGENT_CHAT_HOME']
  else process.env['AGENT_CHAT_HOME'] = previousHome
  fs.rmSync(dir, { recursive: true, force: true })
})

type Reply = ServerMessage & Correlated

/** Sends frames on a bare socket and resolves with the first reply of type `t`. */
async function ask(t: Reply['t'], ...frames: (ClientMessage & Correlated)[]): Promise<Reply> {
  const socket = net.connect(path.join(dir, 'chat.sock'))
  raw = socket
  await new Promise<void>(resolve => socket.once('connect', () => resolve()))
  const answer = new Promise<Reply>(resolve =>
    socket.on(
      'data',
      lineReader<Reply>(
        msg => msg.t === t && resolve(msg),
        () => undefined,
      ),
    ),
  )
  for (const frame of frames) socket.write(encode(frame))
  return answer
}

describe('broker reply correlation', () => {
  it('echoes the request id on the reply', async () => {
    const answer = await ask('agents_result', { t: 'agents', rid: 7 })

    expect(answer).toMatchObject({ t: 'agents_result', rid: 7 })
  })

  it('echoes the id on a reply sent after the handler awaits', async () => {
    const register: ClientMessage = {
      t: 'register',
      name: 'rid-asker',
      workingOn: 'CC-1343',
      cwd: dir,
      pid: process.pid,
    }

    const answer = await ask('claim_result', register, { t: 'claim', worktreePath: dir, rid: 9 })

    expect(answer).toMatchObject({ t: 'claim_result', rid: 9 })
  })

  it('adds no id to the reply of a request that sent none', async () => {
    const answer = await ask('agents_result', { t: 'agents' })

    expect(answer.t).toBe('agents_result')
    expect('rid' in answer).toBe(false)
  })

  it('answers a BrokerClient request end to end', async () => {
    client = new BrokerClient(() => undefined, undefined, undefined, undefined, undefined, {
      autoStart: false,
    })
    await client.connect()

    const answer = await client.request({ t: 'agents' }, 'agents_result')

    expect(answer.t).toBe('agents_result')
    expect('rid' in answer).toBe(false)
  })
})
