import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

/**
 * End-to-end over the real MCP stdio protocol: three "sessions" on one broker,
 * exercising the same path Claude Code drives. Runs against built output, so
 * `npm run build` must have happened first.
 */

const execFileAsync = promisify(execFile)
const CLI = path.resolve(import.meta.dirname, '../../dist/cli.js')
// Isolated home so a broker running for real on this machine is never touched.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-test-'))

const ChannelNotification = z.object({
  method: z.literal('notifications/claude/channel'),
  params: z.object({ content: z.string(), meta: z.record(z.string()).optional() }),
})

type Inbox = z.infer<typeof ChannelNotification>['params'][]

interface Session {
  client: Client
  inbox: Inbox
  transport: StdioClientTransport
}

const sessions: Session[] = []

async function startSession(label: string): Promise<Session> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'mcp'],
    env: { ...process.env, AGENT_CHAT_HOME: TEST_HOME },
  })
  const client = new Client({ name: `test-${label}`, version: '0.0.1' }, { capabilities: {} })
  const inbox: Inbox = []
  client.setNotificationHandler(ChannelNotification, n => void inbox.push(n.params))
  await client.connect(transport)
  const session = { client, inbox, transport }
  sessions.push(session)
  return session
}

async function call(session: Session, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = (await session.client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[]
  }
  return result.content[0]?.text ?? ''
}

const cli = (args: string[]) =>
  execFileAsync(process.execPath, [CLI, ...args], { env: { ...process.env, AGENT_CHAT_HOME: TEST_HOME } })

/** Channel notifications are unacknowledged, so settling is a wait, not an await. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 250))

let alice: Session
let bob: Session
let carol: Session

beforeAll(async () => {
  expect(fs.existsSync(CLI), 'run `npm run build` before the integration test').toBe(true)
  alice = await startSession('alice')
  bob = await startSession('bob')
  carol = await startSession('carol')
  await call(alice, 'chat_register', { name: 'alice', working_on: 'the dashboard' })
  await call(bob, 'chat_register', { name: 'bob', working_on: 'the BLE adapter' })
  await call(carol, 'chat_register', { name: 'carol', working_on: 'docs' })
}, 30000)

afterAll(async () => {
  for (const s of sessions) await s.transport.close().catch(() => undefined)
  fs.rmSync(TEST_HOME, { recursive: true, force: true })
})

describe('reserved names', () => {
  it('refuses a session that tries to register as the human', async () => {
    const impostor = await startSession('impostor-human')
    expect(await call(impostor, 'chat_register', { name: 'human' })).toContain('reserved')
  })
})

describe('directory', () => {
  it('lists every registered session with its work and cwd', async () => {
    const listed = await call(alice, 'chat_list')
    expect(listed).toContain('alice (you)')
    expect(listed).toContain('the BLE adapter')
    expect(listed).toContain('carol')
  })

  it('reflects a status update', async () => {
    await call(carol, 'chat_status', { status: 'blocked', working_on: 'waiting on review' })
    expect(await call(alice, 'chat_list')).toContain('waiting on review')
  })
})

describe('directed delivery', () => {
  it('reaches the addressee and nobody else', async () => {
    const sent = await call(alice, 'chat_send', { to: 'bob', text: 'can you take the left slot?' })
    await settle()

    expect(sent).toMatch(/^Delivered to "bob"/)
    expect(bob.inbox).toHaveLength(1)
    expect(bob.inbox[0]?.content).toBe('can you take the left slot?')
    expect(bob.inbox[0]?.meta?.from).toBe('alice')
    expect(carol.inbox).toHaveLength(0)
    expect(alice.inbox).toHaveLength(0)
  })

  it('does not fan out when the recipient is unknown', async () => {
    const before = [bob.inbox.length, carol.inbox.length]
    const sent = await call(alice, 'chat_send', { to: 'dave', text: 'hello?' })
    await settle()

    expect(sent).toMatch(/^Not delivered/)
    expect([bob.inbox.length, carol.inbox.length]).toEqual(before)
  })

  it('correlates a reply back to the original message', async () => {
    const sent = await call(alice, 'chat_send', { to: 'bob', text: 'ready?' })
    const msgId = /msg_id (\w+)/.exec(sent)?.[1]
    await settle()

    await call(bob, 'chat_send', { to: 'alice', text: 'ready', in_reply_to: msgId })
    await settle()

    expect(alice.inbox.at(-1)?.meta?.in_reply_to).toBe(msgId)
    expect(alice.inbox.at(-1)?.meta?.from).toBe('bob')
  })
})

describe('broadcast', () => {
  it('reaches every session except the sender', async () => {
    const before = alice.inbox.length
    await call(alice, 'chat_broadcast', { text: 'switching branches' })
    await settle()

    expect(bob.inbox.at(-1)?.content).toBe('switching branches')
    expect(bob.inbox.at(-1)?.meta?.broadcast).toBe('true')
    expect(carol.inbox.at(-1)?.content).toBe('switching branches')
    expect(alice.inbox).toHaveLength(before)
  })
})

describe('inbox', () => {
  it('replays messages this session received, and only those', async () => {
    const bobInbox = await call(bob, 'chat_inbox', { limit: 20 })
    expect(bobInbox).toContain('can you take the left slot?')

    const carolInbox = await call(carol, 'chat_inbox', { limit: 20 })
    expect(carolInbox).not.toContain('can you take the left slot?')
    expect(carolInbox).toContain('switching branches')
  })
})

describe('terminal client', () => {
  it('lets a human message one session from the CLI', async () => {
    const before = carol.inbox.length
    const { stdout } = await execFileAsync(process.execPath, [CLI, 'send', 'bob', 'ping from the terminal'], {
      env: { ...process.env, AGENT_CHAT_HOME: TEST_HOME },
    })
    await settle()

    expect(stdout).toMatch(/^Delivered to bob/)
    expect(bob.inbox.at(-1)?.content).toBe('ping from the terminal')
    expect(bob.inbox.at(-1)?.meta?.from).toBe('human')
    expect(carol.inbox).toHaveLength(before)
  })

  it('lists live sessions from the CLI', async () => {
    const { stdout } = await execFileAsync(process.execPath, [CLI, 'ps'], {
      env: { ...process.env, AGENT_CHAT_HOME: TEST_HOME },
    })
    expect(stdout).toContain('alice')
    expect(stdout).toContain('the BLE adapter')
  })
})

describe('human queue', () => {
  it('queues a question for the human without needing anyone attached', async () => {
    const asked = await call(bob, 'chat_ask', { text: 'which branch should the migration target?' })
    expect(asked).toMatch(/Question queued for the human/)

    const { stdout } = await cli(['inbox'])
    expect(stdout).toContain('which branch should the migration target?')
    expect(stdout).toContain('needing an answer')
  })

  it('routes the human answer back to the asker as a channel message', async () => {
    const before = bob.inbox.length
    const { stdout: queued } = await cli(['inbox'])
    const msgId = /ASK\s+(\w+)/.exec(queued)?.[1]
    expect(msgId).toBeDefined()

    await cli(['answer', msgId!, 'target main'])
    await settle()

    expect(bob.inbox.length).toBe(before + 1)
    expect(bob.inbox.at(-1)?.content).toBe('target main')
    expect(bob.inbox.at(-1)?.meta?.from).toBe('human')
    expect(bob.inbox.at(-1)?.meta?.in_reply_to).toBe(msgId)
  })

  it('drops the item from the queue once answered', async () => {
    const { stdout } = await cli(['inbox'])
    expect(stdout).not.toContain('which branch should the migration target?')
  })

  it('keeps notices in the queue but does not count them as needing an answer', async () => {
    await call(carol, 'chat_notify', { text: 'docs pass finished' })
    const { stdout } = await cli(['inbox'])

    expect(stdout).toContain('docs pass finished')
    expect(stdout).toContain('0 needing an answer')
  })

  it('budgets open questions per session', async () => {
    for (let i = 0; i < 3; i++) await call(carol, 'chat_ask', { text: `question ${i}` })
    const overflow = await call(carol, 'chat_ask', { text: 'one too many' })

    expect(overflow).toContain('unanswered questions')
  })

  it('refuses to answer an id that is not open', async () => {
    await expect(cli(['answer', 'deadbeef', 'nope'])).rejects.toThrow()
  })

  it('records everything in one log, queue items included', async () => {
    const { stdout } = await cli(['history', '200'])
    expect(stdout).toContain('question')
    expect(stdout).toContain('answer')
    expect(stdout).toContain('notice')
    expect(stdout).toContain('message')
  })
})

describe('argument validation', () => {
  /**
   * Live regression, 2026-07-27: a session called chat_send with `message` instead
   * of `text`. The SDK does not enforce `required`, so the handler coerced the
   * missing field with String(undefined) and the recipient was delivered the word
   * "undefined" while the sender was told the send succeeded.
   */
  it('refuses a send whose body arrived under the wrong key, delivering nothing', async () => {
    const before = bob.inbox.length
    const sent = await call(alice, 'chat_send', { to: 'bob', message: 'body under the wrong key' })
    await settle()

    expect(sent).toContain('text is required')
    expect(bob.inbox).toHaveLength(before)
    expect(bob.inbox.map(m => m.content)).not.toContain('undefined')
  })

  it('refuses a status outside the enum rather than storing it', async () => {
    expect(await call(bob, 'chat_status', { status: 'busy' })).toContain('must be one of')
    expect(await call(alice, 'chat_list')).not.toContain('busy')
  })

  it('refuses an empty question instead of asking the human nothing', async () => {
    expect(await call(alice, 'chat_ask', { text: '   ' })).toContain('text is required')
  })
})

describe('leases', () => {
  it('rejects a name that a live session holds', async () => {
    const impostor = await startSession('impostor')
    expect(await call(impostor, 'chat_register', { name: 'bob' })).toContain('held by another session')
  })

  it('releases the route when a session exits, and frees the name', async () => {
    const dave = await startSession('dave')
    await call(dave, 'chat_register', { name: 'dave' })
    expect(await call(alice, 'chat_send', { to: 'dave', text: 'hi' })).toMatch(/^Delivered/)

    await dave.transport.close()
    await settle()

    expect(await call(alice, 'chat_send', { to: 'dave', text: 'still there?' })).toMatch(/^Not delivered/)
    const replacement = await startSession('dave2')
    expect(await call(replacement, 'chat_register', { name: 'dave' })).toContain('Registered as "dave"')
  })
})
