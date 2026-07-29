import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { reapBroker } from './broker-harness.js'
import { encode, lineReader, type ClientMessage, type ServerMessage } from '../protocol.js'

/**
 * The two structural guards on teleport, exercised over the real wire rather
 * than through the supervisor — because both are properties of the SOCKET
 * layer, and a unit test of the supervisor would pass with either one deleted.
 *
 * 1. The subject is resolved from the requesting CONNECTION. The frame carries
 *    no name, no id and no pid, so there is no version of this call that ends
 *    someone else's session — not by a check, but by an absent field.
 * 2. The countdown's abort is the human's, and a session cannot reach it. A
 *    descendant able to cancel its predecessor's veto would make the human's 30
 *    seconds a formality.
 *
 * Runs against built output, so `npm run build` must have happened first.
 */

const CLI = path.resolve(import.meta.dirname, '../../dist/cli.js')
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-tguard-'))
const SOCKET = path.join(TEST_HOME, 'chat.sock')

const open: net.Socket[] = []

/** A raw client on the same 0600 socket a tool would use — no MCP layer in the way. */
async function connect(): Promise<net.Socket> {
  const socket = net.connect(SOCKET)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  open.push(socket)
  return socket
}

/** Send one frame and wait for the reply of the given type. */
function ask(socket: net.Socket, message: ClientMessage, replyType: string): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${replyType}`)), 5000)
    const read = lineReader<ServerMessage>(
      msg => {
        if (msg.t !== replyType) return
        clearTimeout(timer)
        socket.off('data', read)
        resolve(msg)
      },
      () => undefined,
    )
    socket.on('data', read)
    socket.write(encode(message))
  })
}

beforeAll(async () => {
  const broker = spawn(process.execPath, [CLI, 'broker'], {
    env: { ...process.env, AGENT_CHAT_HOME: TEST_HOME },
    detached: true,
    stdio: 'ignore',
  })
  broker.unref()
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (fs.existsSync(SOCKET)) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('broker never bound its socket')
}, 20_000)

afterAll(async () => {
  for (const socket of open) socket.destroy()
  await reapBroker(TEST_HOME)
  fs.rmSync(TEST_HOME, { recursive: true, force: true })
})

describe('who may teleport', () => {
  it('refuses a connection with no durable identity, rather than inventing one', async () => {
    const socket = await connect()

    const result = (await ask(socket, { t: 'teleport', handoff: 'x' }, 'teleport_result')) as Extract<
      ServerMessage,
      { t: 'teleport_result' }
    >

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/durable identity/)
  })
})

describe('who may abort a countdown', () => {
  /**
   * The refusal has to come from the connection being REGISTERED, not from the
   * name being unknown — so this asserts the reason, not just the failure. Both
   * arms below ask about a teleport that does not exist; only the answer differs.
   */
  it('refuses a registered session, whatever it names', async () => {
    const socket = await connect()
    await ask(
      socket,
      { t: 'register', name: 'impostor', workingOn: 'trying it on', cwd: TEST_HOME, pid: process.pid },
      'register_result',
    )

    const result = (await ask(
      socket,
      { t: 'teleport_abort', name: 'someone-else' },
      'teleport_result',
    )) as Extract<ServerMessage, { t: 'teleport_result' }>

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/human/)
  })

  it('lets the human at the CLI through to a real answer', async () => {
    const socket = await connect()

    const result = (await ask(
      socket,
      { t: 'teleport_abort', name: 'someone-else' },
      'teleport_result',
    )) as Extract<ServerMessage, { t: 'teleport_result' }>

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/no teleport is counting down/)
  })
})
