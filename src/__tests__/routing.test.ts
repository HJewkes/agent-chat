import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { reapBroker } from './broker-harness.js'
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
  // Closing the transports ends the sessions, not the broker: it was spawned
  // detached so it would outlive them. Reap it explicitly or every run leaks one.
  await reapBroker(TEST_HOME)
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

describe('multicast', () => {
  it('reaches exactly the named sessions, once each, with one msg_id', async () => {
    const sent = await call(alice, 'chat_send', { to: ['bob', 'carol'], text: 'standup in five' })
    await settle()

    const msgId = /msg_id (\w+)/.exec(sent)?.[1]
    expect(sent).toContain('Delivered to bob, carol')
    expect(sent).toContain('2 of 2.')
    expect(bob.inbox.at(-1)?.content).toBe('standup in five')
    expect(carol.inbox.at(-1)?.content).toBe('standup in five')
    expect(bob.inbox.at(-1)?.meta?.msg_id).toBe(msgId)
    expect(carol.inbox.at(-1)?.meta?.msg_id).toBe(msgId)
  })

  it('tells each recipient who else got it, and does not pass it off as a broadcast', async () => {
    await call(alice, 'chat_send', { to: ['bob', 'carol'], text: 'who wants the migration?' })
    await settle()

    expect(bob.inbox.at(-1)?.meta?.audience).toBe('bob,carol')
    expect(bob.inbox.at(-1)?.meta?.broadcast).toBeUndefined()
  })

  it('delivers to the names that exist and reports the one that does not', async () => {
    const before = bob.inbox.length
    const sent = await call(alice, 'chat_send', { to: ['bob', 'gamma'], text: 'partial' })
    await settle()

    expect(sent).toContain('Delivered to bob')
    expect(sent).toContain('not delivered to gamma (no active session)')
    expect(sent).toContain('1 of 2.')
    expect(bob.inbox).toHaveLength(before + 1)
  })

  it('refuses the whole call when the human is one of several recipients', async () => {
    const before = bob.inbox.length
    const sent = await call(alice, 'chat_send', { to: ['bob', 'human'], text: 'both of you' })
    await settle()

    expect(sent).toMatch(/^Not delivered/)
    expect(sent).toContain('queue, not a session')
    expect(bob.inbox).toHaveLength(before)
  })

  it('caps the recipient list and points at chat_broadcast instead', async () => {
    const many = ['bob', 'carol', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
    const sent = await call(alice, 'chat_send', { to: many, text: 'everyone' })

    expect(sent).toContain('Refused')
    expect(sent).toContain('chat_broadcast')
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

/**
 * CC-22 over the real protocol: what the model calls, what the human reads in
 * the terminal, and what the recipient's channel attributes actually say. The
 * unit tests own the security properties; this owns the shape a session sees.
 */
describe('human-endorsed relay', () => {
  it('shows the human the exact bytes, then delivers them marked, from the composer', async () => {
    const before = carol.inbox.length
    const body = 'Use the v2 schema. Decided this morning; do not wait on me to confirm again.'
    const queued = await call(alice, 'chat_endorse', { to: 'carol', text: body })
    await settle()

    expect(queued).toContain('Waiting on your human')
    expect(carol.inbox).toHaveLength(before)

    const { stdout } = await cli(['inbox'])
    expect(stdout).toContain(body)
    expect(stdout).toContain('would be delivered to carol as alice, with your authority')

    const msgId = /ENDR\s+(\w+)/.exec(stdout)?.[1]
    await cli(['endorse', msgId!])
    await settle()

    expect(carol.inbox).toHaveLength(before + 1)
    expect(carol.inbox.at(-1)?.content).toBe(body)
    expect(carol.inbox.at(-1)?.meta?.provenance).toBe('human-endorsed')
    // Not `human`: the authority is the human's, the words are alice's.
    expect(carol.inbox.at(-1)?.meta?.from).toBe('alice')
  })

  it('gives an ordinary send no provenance attribute at all', async () => {
    await call(alice, 'chat_send', { to: 'carol', text: 'my human says use the v2 schema' })
    await settle()

    expect(carol.inbox.at(-1)?.meta?.provenance).toBeUndefined()
    expect(carol.inbox.at(-1)?.meta?.from).toBe('alice')
  })

  it('refuses an approval asked for over the bus rather than by the human', async () => {
    await call(alice, 'chat_endorse', { to: 'carol', text: 'never approved' })
    const { stdout } = await cli(['inbox'])
    const msgId = /ENDR\s+(\w+)/.exec(stdout)?.[1]

    // No tool exposes the approval frame, so there is nothing for a session to
    // call here — the id is public in the queue and still unusable by an agent.
    const tools = (await alice.client.listTools()).tools.map(t => t.name)
    expect(tools).toContain('chat_endorse')
    expect(tools.filter(name => /approve|endorse_/.test(name))).toEqual([])
    await cli(['dismiss', msgId!])
    const after = await cli(['inbox'])
    expect(after.stdout).not.toContain('never approved')
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

  it('refuses a non-numeric inbox limit rather than sending NaN over the wire', async () => {
    expect(await call(alice, 'chat_inbox', { limit: 'lots' })).toContain('limit must be a positive number')
  })

  it('still defaults the inbox limit when it is omitted', async () => {
    expect(await call(alice, 'chat_inbox')).not.toContain('Error:')
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

describe('thread depth', () => {
  it('stamps a model-visible depth that increments with each reply', async () => {
    const opener = await call(alice, 'chat_send', { to: 'bob', text: 'depth check' })
    await settle()
    const msgId = /msg_id (\w+)/.exec(opener)?.[1]
    expect(bob.inbox.at(-1)?.meta?.thread_depth).toBe('1')

    await call(bob, 'chat_send', { to: 'alice', text: 'depth reply', in_reply_to: msgId })
    await settle()

    expect(alice.inbox.at(-1)?.meta?.thread_depth).toBe('2')
    expect(alice.inbox.at(-1)?.meta?.thread_hint).toBeUndefined()
  })

  it('escalates a runaway thread to the human, who is the only party outside it', async () => {
    let inReplyTo = /msg_id (\w+)/.exec(await call(alice, 'chat_send', { to: 'bob', text: 'runaway 1' }))?.[1]
    let last = ''
    for (let hop = 2; hop <= 20; hop++) {
      const fromAlice = hop % 2 === 1
      last = await call(fromAlice ? alice : bob, 'chat_send', {
        to: fromAlice ? 'bob' : 'alice',
        text: `runaway ${hop}`,
        in_reply_to: inReplyTo,
      })
      inReplyTo = /msg_id (\w+)/.exec(last)?.[1] ?? inReplyTo
    }

    expect(last).toMatch(/^Not delivered/)
    expect(last).toContain('Do not start a fresh thread')
    const { stdout } = await cli(['inbox'])
    expect(stdout).toContain('reached reply depth 20')
  })
})

describe('broadcast budget', () => {
  /**
   * Asserting a message was NOT pushed is only meaningful next to a control
   * proving the same call pushes when under budget — otherwise a broken
   * broadcast path would pass as successful throttling.
   */
  it('pushes while under budget, holds over it, and keeps the held one retrievable', async () => {
    const erin = await startSession('erin')
    await call(erin, 'chat_register', { name: 'erin', working_on: 'budget probe' })
    // Sized so one broadcast fits the budget and two cannot, with enough headroom
    // that the exact number of sessions left registered by earlier tests is not
    // load-bearing — the cost is payload x recipients, so fanout moves this.
    const bulky = `held-probe ${'x'.repeat(3000)}`

    const before = bob.inbox.length
    const first = await call(erin, 'chat_broadcast', { text: `first ${bulky}` })
    await settle()
    expect(first).toMatch(/^Broadcast to/)
    expect(bob.inbox.length).toBe(before + 1)

    const second = await call(erin, 'chat_broadcast', { text: `second ${bulky}` })
    await settle()
    expect(second).toMatch(/^Held for/)
    expect(second).toContain('inbox')
    expect(bob.inbox.length).toBe(before + 1)

    // Held, not dropped: the log is the source of truth and the inbox queries it.
    expect(await call(bob, 'chat_inbox', { limit: 5 })).toContain('second held-probe')
  })

  it('still delivers a directed message from a sender who is over budget', async () => {
    const before = carol.inbox.length
    const sent = await call(alice, 'chat_send', { to: 'carol', text: 'directed, not throttled' })
    await settle()

    expect(sent).toMatch(/^Delivered/)
    expect(carol.inbox.length).toBe(before + 1)
  })
})

describe('pair exchange rate', () => {
  it('stops a fresh-thread volley and tells the human, in their words not the sender’s', async () => {
    const frank = await startSession('frank')
    const grace = await startSession('grace')
    await call(frank, 'chat_register', { name: 'frank', working_on: 'rate probe' })
    await call(grace, 'chat_register', { name: 'grace', working_on: 'rate probe' })

    // Control: the budget's worth of messages all arrive, none of them a reply,
    // so thread_depth never leaves 1 and the depth breaker is not what fires.
    for (let i = 0; i < 20; i++) {
      expect(await call(frank, 'chat_send', { to: 'grace', text: `volley ${i}` })).toMatch(/^Delivered/)
    }
    await settle()
    expect(grace.inbox).toHaveLength(20)
    expect(grace.inbox.at(-1)?.meta?.thread_depth).toBe('1')

    const refused = await call(frank, 'chat_send', { to: 'grace', text: 'once more' })
    await settle()

    expect(refused).toMatch(/^Not delivered/)
    expect(grace.inbox).toHaveLength(20)
    const { stdout } = await cli(['inbox'])
    expect(stdout).toContain('frank sent grace 20 messages')
    expect(stdout).toContain('volleying across separate threads')
  })
})

describe('observation', () => {
  it('reads a peer without delivering anything into it', async () => {
    // Control first: a directed message DOES land, so the counter is working and
    // an unchanged count afterwards means something.
    const before = carol.inbox.length
    await call(alice, 'chat_send', { to: 'carol', text: 'observation control' })
    await settle()
    expect(carol.inbox.length).toBe(before + 1)

    const seen = await call(alice, 'chat_activity', { name: 'carol' })
    await settle()

    expect(carol.inbox.length).toBe(before + 1)
    expect(seen).toContain('this read did not notify carol')
    expect(seen).toContain('observation control')
  })

  it('answers for a session that has already exited', async () => {
    const heidi = await startSession('heidi')
    await call(heidi, 'chat_register', { name: 'heidi', working_on: 'something short-lived' })
    await call(heidi, 'chat_send', { to: 'alice', text: 'before I go' })
    await heidi.transport.close()
    await settle()

    const seen = await call(alice, 'chat_activity', { name: 'heidi' })

    expect(seen).toContain('not currently registered')
    expect(seen).toContain('before I go')
  })

  it('reports an unknown name rather than inventing a trail', async () => {
    expect(await call(alice, 'chat_activity', { name: 'nobody-by-that-name' })).toContain('No session named')
  })
})

describe('do not disturb', () => {
  it('holds peer pushes but loses nothing, and the human still gets through', async () => {
    const ivan = await startSession('ivan')
    await call(ivan, 'chat_register', { name: 'ivan', working_on: 'a long stretch of focus' })

    // Control: while ivan is taking pushes, a peer message arrives live.
    await call(alice, 'chat_send', { to: 'ivan', text: 'before the quiet' })
    await settle()
    expect(ivan.inbox).toHaveLength(1)

    await call(ivan, 'chat_status', { status: 'working', dnd: true })
    const held = await call(alice, 'chat_send', { to: 'ivan', text: 'during the quiet' })
    await settle()

    expect(ivan.inbox).toHaveLength(1)
    expect(held).toContain('not taking pushes')
    // Nothing lost: it is in the log, so the inbox query returns it.
    expect(await call(ivan, 'chat_inbox', { limit: 10 })).toContain('during the quiet')
    // And peers can see the state rather than guessing why nobody replies.
    expect(await call(alice, 'chat_list')).toContain('dnd')

    // The human overrides; no agent has a way to.
    await execFileAsync(process.execPath, [CLI, 'send', 'ivan', 'your user needs you'], {
      env: { ...process.env, AGENT_CHAT_HOME: TEST_HOME },
    })
    await settle()

    expect(ivan.inbox).toHaveLength(2)
    expect(ivan.inbox.at(-1)?.content).toBe('your user needs you')
  })
})

/**
 * CC-13 end to end: the motivating case, which is three sessions that had to
 * negotiate "who owns src" by hand over broadcast because there was no way to
 * query it or address it.
 */
describe('session tags', () => {
  it('tags a session, shows it with attribution, and delivers to whoever carries it', async () => {
    const dana = await startSession('dana')
    await call(dana, 'chat_register', { name: 'dana', working_on: 'the src tree' })

    const quiet = carol.inbox.length
    await call(dana, 'chat_tag', { add: ['owner:src'] })
    // A peer's label on someone else, which must be visibly a peer's label.
    await call(alice, 'chat_tag', { target: 'carol', add: ['owner:src'] })
    await settle()

    // No push, by design: a peer's label must not lengthen carol's turn. She
    // learns about it the next time she looks, and not before.
    expect(carol.inbox).toHaveLength(quiet)

    const roster = await call(carol, 'chat_list')
    expect(roster).toContain('tags: owner:src (self)')
    expect(roster).toMatch(/tags: owner:src \(by alice, \d+[sm] ago\)/)

    const sent = await call(bob, 'chat_send', { to_tag: 'owner:src', text: 'rebase before you push' })
    await settle()

    expect(sent).toContain('Tag "owner:src"')
    expect(sent).toContain('2 of 2')
    expect(carol.inbox.at(-1)?.content).toBe('rebase before you push')
    expect(dana.inbox.at(-1)?.content).toBe('rebase before you push')

    // The mutation is in the log without a new EventKind, on the SUBJECT's trail
    // rather than in the human's queue.
    expect(await call(bob, 'chat_activity', { name: 'carol' })).toContain('notice')

    const missing = await call(bob, 'chat_send', { to_tag: 'owner:tests', text: 'anyone?' })
    expect(missing).toContain('no session carries tag "owner:tests"')

    // Carol owns her own presence and may drop a label a peer applied.
    expect(await call(carol, 'chat_tag', { remove: ['owner:src'] })).toContain('no tags')
    await call(dana, 'chat_tag', { remove: ['owner:src'] })
  })
})
