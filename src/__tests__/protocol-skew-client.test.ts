import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrokerClient } from '../client/broker-client.js'
import { encode, lineReader, type ClientMessage, type Correlated, type ServerMessage } from '../protocol.js'
import { PROTOCOL_TOO_OLD, PROTOCOL_VERSION } from '../protocol-version.js'
import { ToolHandler } from '../server/tools.js'

/**
 * CC-1728, client half: every registration states this build's protocol, and a
 * broker refusal of that protocol is kept and shown on every tool result, so a
 * session that cannot get on the bus says why instead of failing tool by tool.
 */

const REFUSAL = 'your agent-chat build (/opt/old/dist/cli.js) speaks protocol 0; rebuild agent-chat on Mac'

let dir: string
let server: net.Server
let brokerSide: net.Socket | undefined
let received: (ClientMessage & Correlated)[]
let client: BrokerClient | undefined
const previousHome = process.env['AGENT_CHAT_HOME']

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i += 1) await tick()
  expect(predicate()).toBe(true)
}

async function connected(): Promise<BrokerClient> {
  const c = new BrokerClient(() => undefined, undefined, undefined, undefined, undefined, {
    autoStart: false,
  })
  await c.connect()
  await until(() => brokerSide !== undefined)
  return c
}

/** Registers through `c`, answering the frame the way a broker on a newer protocol would. */
async function registerAgainst(
  c: BrokerClient,
  answer: Omit<Extract<ServerMessage, { t: 'register_result' }>, 't'>,
) {
  const pending = c.request(
    { t: 'register', name: 'n', workingOn: '', cwd: '/tmp', pid: 1 },
    'register_result',
  )
  await until(() => received.length > 0)
  brokerSide?.write(encode({ t: 'register_result', ...answer, rid: received.at(-1)?.rid }))
  return pending
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac1728-'))
  process.env['AGENT_CHAT_HOME'] = dir
  received = []
  brokerSide = undefined
  server = net.createServer(conn => {
    brokerSide = conn
    conn.on(
      'data',
      lineReader<ClientMessage & Correlated>(
        msg => received.push(msg),
        () => undefined,
      ),
    )
  })
  await new Promise<void>(resolve => server.listen(path.join(dir, 'chat.sock'), resolve))
})

afterEach(async () => {
  vi.restoreAllMocks()
  client?.close()
  client = undefined
  brokerSide?.destroy()
  await new Promise<void>(resolve => server.close(() => resolve()))
  if (previousHome === undefined) delete process.env['AGENT_CHAT_HOME']
  else process.env['AGENT_CHAT_HOME'] = previousHome
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('a client registering with the broker', () => {
  it('states the protocol it speaks on every registration', async () => {
    client = await connected()

    await registerAgainst(client, { ok: true })

    expect(received[0]).toMatchObject({ t: 'register', protocol: PROTOCOL_VERSION })
  })

  it('reports a protocol refusal on stderr and keeps it until a registration succeeds', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    client = await connected()

    await registerAgainst(client, { ok: false, reason: REFUSAL, code: PROTOCOL_TOO_OLD })

    expect(client.protocolSkew()).toBe(REFUSAL)
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(REFUSAL))
    await registerAgainst(client, { ok: true })
    expect(client.protocolSkew()).toBeUndefined()
  })

  it('shows the refusal on chat tool results while it stands', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    client = await connected()
    await registerAgainst(client, { ok: false, reason: REFUSAL, code: PROTOCOL_TOO_OLD })

    const result = await new ToolHandler(client).handle('chat_send', { to: 'peer', text: 'hi' }).catch(e => e)

    const shown = result instanceof Error ? result.message : JSON.stringify(result)
    expect(shown).toContain(REFUSAL)
  })

  it('adds nothing to tool results for a build the broker serves', async () => {
    client = await connected()
    await registerAgainst(client, { ok: true })

    expect(client.protocolSkew()).toBeUndefined()
  })
})
