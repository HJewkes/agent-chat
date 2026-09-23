import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { serveTools } from '../server/index.js'
import { ToolHandler } from '../server/tools.js'
import type { BrokerClient } from '../client/broker-client.js'
import type { ClientMessage, ServerMessage, SessionInfo } from '../protocol.js'

/**
 * Golden files for what an MCP client sees (CC-106).
 *
 * The registry migration moves tool definitions and argument validation out of
 * hand-written code, and the descriptions it carries are prompts that steer
 * model behaviour. These pin the bytes a client receives — the tools/list
 * response and the text of representative calls — so a conversion that changes
 * either fails here, and an intended change shows up as a golden-file diff.
 */

interface Wire {
  client: Client
  sent: ClientMessage[]
  responses: JSONRPCMessage[]
}

function fakeBroker(reply: ServerMessage | undefined, sent: ClientMessage[]): BrokerClient {
  return {
    request: async (message: ClientMessage) => {
      sent.push(message)
      if (reply === undefined) throw new Error('no broker reply scripted for this case')
      return reply
    },
  } as unknown as BrokerClient
}

/** A real Server and Client over an in-memory pipe, recording what the server puts on the wire. */
async function connect(reply?: ServerMessage, registeredAs?: string): Promise<Wire> {
  const sent: ClientMessage[] = []
  const responses: JSONRPCMessage[] = []
  const server = new Server({ name: 'agent-chat', version: '0.1.0' }, { capabilities: { tools: {} } })
  serveTools(server, new ToolHandler(fakeBroker(reply, sent), undefined, registeredAs))
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const send = serverSide.send.bind(serverSide)
  serverSide.send = async message => {
    responses.push(message)
    return send(message)
  }
  await server.connect(serverSide)
  const client = new Client({ name: 'golden', version: '0.0.0' })
  await client.connect(clientSide)
  return { client, sent, responses }
}

describe('tools/list golden', () => {
  it('matches the pinned wire response byte for byte', async () => {
    const wire = await connect()

    await wire.client.listTools()

    const response = wire.responses.find(m => 'result' in m && 'tools' in (m.result as object))
    await expect(
      JSON.stringify((response as { result: unknown }).result, null, 2) + '\n',
    ).toMatchFileSnapshot('./golden/tools-list.json')
  })
})

interface CallCase {
  label: string
  tool: string
  args: Record<string, unknown>
  reply?: ServerMessage
  registeredAs?: string
}

const session = (name: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  name,
  workingOn: `${name} work`,
  cwd: `/work/${name}`,
  status: 'working',
  dnd: false,
  idleMs: 5_000,
  registeredAt: 0,
  ...extra,
})

const sent = (extra: Partial<Extract<ServerMessage, { t: 'send_result' }>>): ServerMessage => ({
  t: 'send_result',
  ok: true,
  msgId: 'm-1',
  recipients: [],
  ...extra,
})

const nine = Array.from({ length: 9 }, (_, i) => `peer-${i}`)

const CHAT_LIST_CASES: CallCase[] = [
  { label: 'empty roster', tool: 'chat_list', args: {}, reply: { t: 'list_result', sessions: [] } },
  {
    label: 'roster with self, a claim and a colliding peer',
    tool: 'chat_list',
    registeredAs: 'me',
    args: {},
    reply: {
      t: 'list_result',
      sessions: [
        session('me', { observed: { worktreePath: '/work/repo' } }),
        session('bob', { dnd: true, provisional: true, declared: { role: 'reviewer' } }),
      ],
      claims: [{ owner: 'bob', kind: 'files', patterns: ['src/**'], worktreePath: '/work/repo', at: 0 }],
    },
  },
]

const CHAT_SEND_CASES: CallCase[] = [
  { label: 'unregistered sender', tool: 'chat_send', args: { to: 'bob', text: 'hi' } },
  {
    label: 'delivered to one name, replying',
    tool: 'chat_send',
    registeredAs: 'me',
    args: { to: 'bob', text: 'hi', in_reply_to: 'm-0' },
    reply: sent({ recipients: ['bob'] }),
  },
  {
    label: 'held for one name',
    tool: 'chat_send',
    registeredAs: 'me',
    args: { to: 'bob', text: 'hi' },
    reply: sent({ recipients: ['bob'], held: true, reason: 'bob is on dnd' }),
  },
  {
    label: 'refused by the broker',
    tool: 'chat_send',
    registeredAs: 'me',
    args: { to: 'ghost', text: 'hi' },
    reply: sent({ ok: false, reason: 'no session named "ghost"' }),
  },
  {
    label: 'multicast with one miss',
    tool: 'chat_send',
    registeredAs: 'me',
    args: { to: ['bob', 'ann', 'ghost'], text: 'hi' },
    reply: sent({
      results: [
        { name: 'bob', status: 'delivered' },
        { name: 'ann', status: 'no_channel' },
        { name: 'ghost', status: 'no_such_session' },
      ],
    }),
  },
  {
    label: 'to a tag',
    tool: 'chat_send',
    registeredAs: 'me',
    args: { to_tag: 'owner:src', text: 'hi' },
    reply: sent({ results: [{ name: 'bob', status: 'held' }] }),
  },
  {
    label: 'over the multicast cap',
    tool: 'chat_send',
    registeredAs: 'me',
    args: { to: nine, text: 'hi' },
  },
  {
    label: 'both to and to_tag',
    tool: 'chat_send',
    registeredAs: 'me',
    args: { to: 'bob', to_tag: 'owner:src', text: 'hi' },
  },
  { label: 'no recipient at all', tool: 'chat_send', registeredAs: 'me', args: { text: 'hi' } },
  { label: 'text omitted', tool: 'chat_send', registeredAs: 'me', args: { to: 'bob' } },
  { label: 'text blank', tool: 'chat_send', registeredAs: 'me', args: { to: 'bob', text: '   ' } },
  { label: 'empty recipient list', tool: 'chat_send', registeredAs: 'me', args: { to: [], text: 'hi' } },
  {
    label: 'blank name inside the list',
    tool: 'chat_send',
    registeredAs: 'me',
    args: { to: ['bob', ''], text: 'hi' },
  },
  {
    label: 'malformed tag',
    tool: 'chat_send',
    registeredAs: 'me',
    args: { to_tag: 'owner of src', text: 'hi' },
  },
]

const inboxReply = (): ServerMessage => ({ t: 'inbox_result', messages: [] })

/** CC-106 S2: `limit` moves from `boundedLimit` to `positiveLimit` + `clampLimit`. */
const CHAT_INBOX_CASES: CallCase[] = [
  { label: 'limit omitted', tool: 'chat_inbox', args: {}, reply: inboxReply() },
  { label: 'limit "5"', tool: 'chat_inbox', args: { limit: '5' }, reply: inboxReply() },
  { label: 'limit 5.7', tool: 'chat_inbox', args: { limit: 5.7 }, reply: inboxReply() },
  { label: 'limit 999', tool: 'chat_inbox', args: { limit: 999 }, reply: inboxReply() },
  { label: 'limit 0', tool: 'chat_inbox', args: { limit: 0 } },
  { label: 'limit "lots"', tool: 'chat_inbox', args: { limit: 'lots' } },
]

/** CC-106 S2: a blank `name` must still read the caller's own transcript, via `present()`. */
const CHAT_TRANSCRIPT_CASES: CallCase[] = [
  { label: 'blank name reads own transcript', tool: 'chat_transcript', args: { name: '   ' } },
]

const AGENT_SURFACE_CASES: CallCase[] = [
  { label: 'name omitted', tool: 'agent_surface', args: {} },
  {
    label: 'surfaced into a pane',
    tool: 'agent_surface',
    args: { name: 'scout' },
    reply: { t: 'switch_result', ok: true, name: 'scout', surface: 'iterm-pane' },
  },
  {
    label: 'refused: already in a terminal',
    tool: 'agent_surface',
    args: { name: 'scout' },
    reply: { t: 'switch_result', ok: false, reason: 'scout is already in a terminal' },
  },
]

/** CC-106 S3: unregistered, registered, blank text, and a broker refusal, for each human-queue write. */
const CHAT_BROADCAST_CASES: CallCase[] = [
  { label: 'unregistered sender', tool: 'chat_broadcast', args: { text: 'hi' } },
  {
    label: 'delivered to the roster',
    tool: 'chat_broadcast',
    registeredAs: 'me',
    args: { text: 'hi' },
    reply: sent({ recipients: ['bob', 'ann'] }),
  },
  { label: 'text blank', tool: 'chat_broadcast', registeredAs: 'me', args: { text: '   ' } },
  {
    label: 'refused by the broker',
    tool: 'chat_broadcast',
    registeredAs: 'me',
    args: { text: 'hi' },
    reply: sent({ ok: false, reason: 'broadcast budget exceeded' }),
  },
]

const CHAT_ASK_CASES: CallCase[] = [
  { label: 'unregistered sender', tool: 'chat_ask', args: { text: 'what now?' } },
  {
    label: 'queued for the human',
    tool: 'chat_ask',
    registeredAs: 'me',
    args: { text: 'what now?' },
    reply: sent({}),
  },
  { label: 'text blank', tool: 'chat_ask', registeredAs: 'me', args: { text: '   ' } },
  {
    label: 'refused by the broker',
    tool: 'chat_ask',
    registeredAs: 'me',
    args: { text: 'what now?' },
    reply: sent({ ok: false, reason: 'already have 3 unanswered questions' }),
  },
]

const CHAT_NOTIFY_CASES: CallCase[] = [
  { label: 'unregistered sender', tool: 'chat_notify', args: { text: 'done with the migration' } },
  {
    label: 'left for the human',
    tool: 'chat_notify',
    registeredAs: 'me',
    args: { text: 'done with the migration' },
    reply: sent({}),
  },
  { label: 'text blank', tool: 'chat_notify', registeredAs: 'me', args: { text: '   ' } },
  {
    label: 'refused by the broker',
    tool: 'chat_notify',
    registeredAs: 'me',
    args: { text: 'done with the migration' },
    reply: sent({ ok: false, reason: 'queue is full' }),
  },
]

const CHAT_ENDORSE_CASES: CallCase[] = [
  { label: 'unregistered sender', tool: 'chat_endorse', args: { to: 'bob', text: 'ship it' } },
  {
    label: 'waiting on the human',
    tool: 'chat_endorse',
    registeredAs: 'me',
    args: { to: 'bob', text: 'ship it' },
    reply: sent({}),
  },
  { label: 'text blank', tool: 'chat_endorse', registeredAs: 'me', args: { to: 'bob', text: '   ' } },
  {
    label: 'refused by the broker',
    tool: 'chat_endorse',
    registeredAs: 'me',
    args: { to: 'bob', text: 'ship it' },
    reply: sent({ ok: false, reason: 'already have 2 waiting' }),
  },
]

const AGENT_BACKGROUND_CASES: CallCase[] = [
  { label: 'unregistered', tool: 'agent_background', args: {} },
  {
    label: 'going headless',
    tool: 'agent_background',
    registeredAs: 'me',
    args: {},
    reply: { t: 'switch_result', ok: true },
  },
  {
    label: 'refused',
    tool: 'agent_background',
    registeredAs: 'me',
    args: {},
    reply: { t: 'switch_result', ok: false, reason: 'no headless surface available' },
  },
]

async function render(c: CallCase): Promise<string> {
  const wire = await connect(c.reply, c.registeredAs)
  const result = await wire.client.callTool({ name: c.tool, arguments: c.args })
  const frames = wire.sent.map(f => `frame: ${JSON.stringify(f)}`).join('\n')
  return `=== ${c.tool}: ${c.label}\nargs: ${JSON.stringify(c.args)}\n${frames}${frames ? '\n' : ''}${JSON.stringify(result.content, null, 2)}\n`
}

describe('tool call golden', () => {
  it.each([
    ['chat_list', CHAT_LIST_CASES],
    ['chat_send', CHAT_SEND_CASES],
    ['chat_inbox', CHAT_INBOX_CASES],
    ['chat_transcript', CHAT_TRANSCRIPT_CASES],
    ['chat_broadcast', CHAT_BROADCAST_CASES],
    ['chat_ask', CHAT_ASK_CASES],
    ['chat_notify', CHAT_NOTIFY_CASES],
    ['chat_endorse', CHAT_ENDORSE_CASES],
    ['agent_surface', AGENT_SURFACE_CASES],
    ['agent_background', AGENT_BACKGROUND_CASES],
  ])('%s answers every pinned case exactly as before', async (tool, cases) => {
    const rendered: string[] = []
    for (const c of cases) rendered.push(await render(c))

    await expect(rendered.join('\n')).toMatchFileSnapshot(`./golden/calls-${tool}.txt`)
  })
})
