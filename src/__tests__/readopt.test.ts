import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { reapBroker } from './broker-harness.js'
import { encode, lineReader, type ClientMessage, type ServerMessage } from '../protocol.js'

/**
 * CC-31 — a session whose MCP subprocess is replaced comes back holding nothing.
 *
 * Registration is per-connection BY DESIGN, so this is not a defect in adoption;
 * what makes it dangerous is that the model already called `chat_register`
 * earlier in the conversation and has no reason to call it again. From inside,
 * the session still looks registered.
 *
 * Exercised over the real wire rather than through the core, because the two
 * properties that matter are properties of the SOCKET layer and a unit test
 * would pass with either deleted:
 *
 * 1. The frame NAMES NO NAME. The broker resolves it from its own log, so this
 *    cannot become a way to claim a name by quoting a session id.
 * 2. It refuses to displace a live connection, so a healthy peer is never
 *    evicted to fix a problem it does not have.
 *
 * Runs against built output, so `npm run build` must have happened first.
 */

const CLI = path.resolve(import.meta.dirname, '../../dist/cli.js')
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-readopt-'))
const SOCKET = path.join(TEST_HOME, 'chat.sock')

const SESSION = '11111111-2222-3333-4444-555555555555'

const open: net.Socket[] = []

async function connect(): Promise<net.Socket> {
  const socket = net.connect(SOCKET)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  open.push(socket)
  return socket
}

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

const registerResult = (msg: ServerMessage): Extract<ServerMessage, { t: 'register_result' }> =>
  msg as Extract<ServerMessage, { t: 'register_result' }>

/** An ordinary session announcing itself the way `chat_register` does. */
async function registerOnce(name: string, sessionId: string): Promise<net.Socket> {
  const socket = await connect()
  const res = registerResult(
    await ask(
      socket,
      { t: 'register', name, workingOn: 'the original work', cwd: TEST_HOME, pid: 4242, sessionId },
      'register_result',
    ),
  )
  expect(res.ok).toBe(true)
  return socket
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

describe('a session whose MCP server was replaced', () => {
  it('comes back under the name it already held, without being told it', async () => {
    const first = await registerOnce('rejoiner', SESSION)
    // The subprocess dying is exactly this: the socket goes, the identity stays.
    first.destroy()
    await new Promise(resolve => setTimeout(resolve, 150))

    const second = await connect()
    const res = registerResult(
      await ask(second, { t: 'readopt', sessionId: SESSION, cwd: TEST_HOME, pid: 4243 }, 'register_result'),
    )

    expect(res.ok).toBe(true)
    // The name came from the LOG. Nothing in the frame carried it, which is the
    // whole reason this cannot be used to claim someone else's name.
    expect(res.name).toBe('rejoiner')
  })

  it('is back on the roster afterwards, which is the point', async () => {
    const list = (await ask(await connect(), { t: 'list' }, 'list_result')) as Extract<
      ServerMessage,
      { t: 'list_result' }
    >
    expect(list.sessions.map(s => s.name)).toContain('rejoiner')
  })

  /**
   * A first-run session has nothing to reclaim, and that is the ordinary case
   * rather than an error — it falls through to `chat_register` as always.
   */
  it('reports nothing to reclaim for a session the broker has never seen', async () => {
    const res = registerResult(
      await ask(
        await connect(),
        { t: 'readopt', sessionId: 'ffffffff-0000-0000-0000-000000000000', cwd: TEST_HOME, pid: 9 },
        'register_result',
      ),
    )
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/no previous registration/)
  })

  /**
   * The dangerous version of this feature would evict whoever currently holds
   * the name. A live connection means nothing was lost, so there is nothing to
   * repair and a healthy peer must not be disturbed.
   */
  it('refuses to displace a session that is still connected', async () => {
    const live = '99999999-8888-7777-6666-555555555555'
    await registerOnce('holder', live)

    const res = registerResult(
      await ask(
        await connect(),
        { t: 'readopt', sessionId: live, cwd: TEST_HOME, pid: 77 },
        'register_result',
      ),
    )

    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/already connected/)
  })
})

/**
 * CC-36 — a client can register perfectly while running a DIFFERENT build from
 * the broker, and then advertise a stale tool list. It appears healthy from both
 * sides; only the tools are wrong. This cost most of an hour during the CC-23
 * live runs, read as a feature defect the whole time.
 */
describe('a client running a different build from the broker', () => {
  it('is registered, because a mismatch is usually harmless', async () => {
    const socket = await connect()
    const res = registerResult(
      await ask(
        socket,
        {
          t: 'register',
          name: 'oldbuild',
          workingOn: 'x',
          cwd: TEST_HOME,
          pid: 5150,
          build: '/somewhere/else/dist/cli.js',
        },
        'register_result',
      ),
    )
    expect(res.ok).toBe(true)
  })

  /** What is not acceptable is that it be silent. */
  it('is said out loud, naming both builds', async () => {
    const res = (await ask(await connect(), { t: 'history', limit: 30 }, 'history_result')) as Extract<
      ServerMessage,
      { t: 'history_result' }
    >
    const notice = res.items.find(i => i.text?.includes('different agent-chat build'))
    expect(notice).toBeDefined()
    expect(notice?.text).toContain('/somewhere/else/dist/cli.js')
    expect(notice?.text).toContain('oldbuild')
  })

  it('says nothing when the builds agree, which is every ordinary session', async () => {
    await ask(
      await connect(),
      { t: 'register', name: 'samebuild', workingOn: 'x', cwd: TEST_HOME, pid: 5151, build: CLI },
      'register_result',
    )
    const res = (await ask(await connect(), { t: 'history', limit: 30 }, 'history_result')) as Extract<
      ServerMessage,
      { t: 'history_result' }
    >
    expect(res.items.some(i => i.text?.includes('samebuild is running a different'))).toBe(false)
  })
})
