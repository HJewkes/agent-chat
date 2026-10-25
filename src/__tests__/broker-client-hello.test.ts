import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BrokerClient } from '../client/broker-client.js'
import { encode, lineReader, type ClientMessage, type Correlated } from '../protocol.js'

/**
 * CC-1138 slice C: a client carrying `AGENT_CHAT_AGENT_ID` opens every connection with a
 * `hello`, against a fake broker that, like a broker built before the frame, never answers it.
 */

let dir: string
let server: net.Server
let connections: { socket: net.Socket; frames: (ClientMessage & Correlated)[] }[]
let client: BrokerClient | undefined
const previousHome = process.env['AGENT_CHAT_HOME']

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5))

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !predicate(); i += 1) await tick()
  expect(predicate()).toBe(true)
}

const framesOn = (index: number): string[] => connections[index]?.frames.map(frame => frame.t) ?? []

async function connected(env: NodeJS.ProcessEnv): Promise<BrokerClient> {
  const c = new BrokerClient(() => undefined, undefined, undefined, undefined, undefined, {
    autoStart: false,
    env,
  })
  await c.connect()
  await until(() => connections.length === 1)
  return c
}

const register = (c: BrokerClient): Promise<unknown> =>
  c
    .request({ t: 'register', name: 'w-hello', workingOn: 'testing', cwd: '/tmp', pid: 1 }, 'register_result')
    .catch((err: unknown) => err)

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac1138-'))
  process.env['AGENT_CHAT_HOME'] = dir
  connections = []
  server = net.createServer(socket => {
    const entry = { socket, frames: [] as (ClientMessage & Correlated)[] }
    connections.push(entry)
    socket.on(
      'data',
      lineReader<ClientMessage & Correlated>(
        msg => {
          entry.frames.push(msg)
          if (msg.t === 'list') socket.write(encode({ t: 'list_result', sessions: [] }))
        },
        () => undefined,
      ),
    )
  })
  await new Promise<void>(resolve => server.listen(path.join(dir, 'chat.sock'), resolve))
})

afterEach(async () => {
  client?.close()
  client = undefined
  for (const { socket } of connections) socket.destroy()
  await new Promise<void>(resolve => server.close(() => resolve()))
  if (previousHome === undefined) delete process.env['AGENT_CHAT_HOME']
  else process.env['AGENT_CHAT_HOME'] = previousHome
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('the hello a client sends', () => {
  it('opens the connection with the declared agent id before any other frame', async () => {
    client = await connected({ AGENT_CHAT_AGENT_ID: 'abc' })
    void register(client)

    await until(() => framesOn(0).length === 2)
    expect(connections[0]!.frames[0]).toEqual({ t: 'hello', agentId: 'abc' })
    expect(framesOn(0)).toEqual(['hello', 'register'])
  })

  // Mutation caught: sending the hello only on the first connect.
  it('says hello again on a reconnect, ahead of the replayed registration', async () => {
    client = await connected({ AGENT_CHAT_AGENT_ID: 'abc' })
    void register(client)
    await until(() => framesOn(0).length === 2)

    connections[0]!.socket.destroy()

    await until(() => framesOn(1).length === 2)
    expect(connections[1]!.frames[0]).toEqual({ t: 'hello', agentId: 'abc' })
    expect(framesOn(1)).toEqual(['hello', 'register'])
  })

  it.each([
    ['unset', {}],
    ['blank', { AGENT_CHAT_AGENT_ID: '  ' }],
  ])('writes no hello when the agent id is %s', async (_case, env) => {
    client = await connected(env)
    void register(client)

    await until(() => framesOn(0).length === 1)
    expect(framesOn(0)).toEqual(['register'])
  })

  it('is answered by nothing, so a broker that ignores it still answers the next request', async () => {
    client = await connected({ AGENT_CHAT_AGENT_ID: 'abc' })

    const reply = await client.request({ t: 'list' }, 'list_result')

    expect(reply).toEqual({ t: 'list_result', sessions: [] })
    expect(framesOn(0)).toEqual(['hello', 'list'])
  })
})
