import { describe, expect, it, vi } from 'vitest'
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
  env?: Record<string, string | undefined>
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

const claimed = (patterns?: string[]): ServerMessage => ({
  t: 'claim_result',
  ok: true,
  claim: {
    owner: 'me',
    kind: patterns === undefined ? 'worktree' : 'files',
    patterns: patterns ?? [],
    worktreePath: '/work/repo',
    at: 0,
  },
})

const twentyFive = Array.from({ length: 25 }, (_, i) => `src/g${i}/**`)

/** CC-106 S4: `patterns` moves from `optionalPatterns` to `patternList`; `[]` still means the whole worktree (CC-56). */
const CHAT_CLAIM_CASES: CallCase[] = [
  { label: 'patterns omitted claims the worktree', tool: 'chat_claim', args: {}, reply: claimed() },
  { label: 'patterns [] claims the worktree', tool: 'chat_claim', args: { patterns: [] }, reply: claimed() },
  { label: 'only blank patterns', tool: 'chat_claim', args: { patterns: ['  '] }, reply: claimed() },
  {
    label: 'patterns trimmed, blanks dropped',
    tool: 'chat_claim',
    args: { patterns: [' src/** ', '', 'docs/*.md'] },
    reply: claimed(['src/**', 'docs/*.md']),
  },
  { label: '25 globs', tool: 'chat_claim', args: { patterns: twentyFive } },
  {
    label: 'another worktree',
    tool: 'chat_claim',
    args: { patterns: ['src/**'], worktree_path: '/work/other' },
    reply: claimed(['src/**']),
  },
  { label: 'blank worktree_path', tool: 'chat_claim', args: { worktree_path: '   ' }, reply: claimed() },
  {
    label: 'claimed with no claim echoed',
    tool: 'chat_claim',
    args: {},
    reply: { t: 'claim_result', ok: true },
  },
  {
    label: 'refused by a peer',
    tool: 'chat_claim',
    args: { patterns: ['src/**'] },
    reply: { t: 'claim_result', ok: false, reason: 'bob already claims src/** in /work/repo' },
  },
  {
    label: 'refused with no reason',
    tool: 'chat_claim',
    args: {},
    reply: { t: 'claim_result', ok: false },
  },
  {
    label: 'patterns as a bare string',
    tool: 'chat_claim',
    args: { patterns: 'src/**' },
    reply: claimed(['src/**']),
  },
  { label: 'patterns null', tool: 'chat_claim', args: { patterns: null }, reply: claimed() },
  {
    label: 'a non-string pattern',
    tool: 'chat_claim',
    args: { patterns: ['src/**', 42] },
    reply: claimed(['src/**']),
  },
]

const CHAT_RELEASE_CASES: CallCase[] = [
  { label: 'everything', tool: 'chat_release', args: {}, reply: { t: 'release_result', released: true } },
  {
    label: 'one worktree',
    tool: 'chat_release',
    args: { worktree_path: '/work/repo' },
    reply: { t: 'release_result', released: true },
  },
  {
    label: 'blank worktree_path releases everything',
    tool: 'chat_release',
    args: { worktree_path: ' ' },
    reply: { t: 'release_result', released: true },
  },
  {
    label: 'nothing held there',
    tool: 'chat_release',
    args: { worktree_path: '/work/none' },
    reply: { t: 'release_result', released: false },
  },
]

const tagged = (subject: string, ...tags: string[]): ServerMessage => ({
  t: 'tag_result',
  ok: true,
  subject,
  tags: tags.map(tag => ({ tag, by: 'me', at: 0 })),
})

const seventeen = Array.from({ length: 17 }, (_, i) => `t${i}`)

/** CC-106 S4: `add`/`remove` move from `optionalTags` to `tagList`; tag rules keep their wording. */
const CHAT_TAG_CASES: CallCase[] = [
  { label: 'unregistered', tool: 'chat_tag', args: { add: ['owner:src'] } },
  { label: 'unregistered with a bad tag', tool: 'chat_tag', args: { add: ['owner of src'] } },
  { label: 'nothing to add or remove', tool: 'chat_tag', registeredAs: 'me', args: {} },
  { label: 'empty add list', tool: 'chat_tag', registeredAs: 'me', args: { add: [] } },
  {
    label: 'tag self',
    tool: 'chat_tag',
    registeredAs: 'me',
    args: { add: ['owner:src'] },
    reply: tagged('me', 'owner:src'),
  },
  {
    label: 'tag a peer, blank target is self',
    tool: 'chat_tag',
    registeredAs: 'me',
    args: { target: '  ', remove: ['lead'] },
    reply: tagged('me'),
  },
  {
    label: 'tag a peer',
    tool: 'chat_tag',
    registeredAs: 'me',
    args: { target: 'bob', add: ['owner:docs'], remove: ['lead'] },
    reply: tagged('bob', 'owner:docs'),
  },
  {
    label: 'refused by the broker',
    tool: 'chat_tag',
    registeredAs: 'me',
    args: { target: 'bob', remove: ['lead'] },
    reply: { t: 'tag_result', ok: false, reason: 'bob carries no tag "lead" that you applied', tags: [] },
  },
  { label: '17 tags', tool: 'chat_tag', registeredAs: 'me', args: { add: seventeen } },
  { label: '33-character tag', tool: 'chat_tag', registeredAs: 'me', args: { add: ['x'.repeat(33)] } },
  { label: 'blank tag in remove', tool: 'chat_tag', registeredAs: 'me', args: { remove: ['ok', ''] } },
  {
    label: 'add as a bare string',
    tool: 'chat_tag',
    registeredAs: 'me',
    args: { add: 'owner:src' },
    reply: tagged('me', 'owner:src'),
  },
  {
    label: 'add null',
    tool: 'chat_tag',
    registeredAs: 'me',
    args: { add: null, remove: ['lead'] },
    reply: tagged('me'),
  },
  { label: 'a non-string tag', tool: 'chat_tag', registeredAs: 'me', args: { add: [42] } },
]

const subscribed = (held = 1): ServerMessage => ({ t: 'subscribe_result', ok: true, held })

/** CC-106 S4: the scope/target rule stays in `run`; absent `kinds` still means joins and leaves. */
const CHAT_SUBSCRIBE_CASES: CallCase[] = [
  { label: 'scope all, kinds omitted', tool: 'chat_subscribe', args: { scope: 'all' }, reply: subscribed() },
  {
    label: 'scope name with kinds',
    tool: 'chat_subscribe',
    args: { scope: 'name', target: 'bob', kinds: ['agent_spawned', 'deregistered'] },
    reply: subscribed(2),
  },
  {
    label: 'scope tag',
    tool: 'chat_subscribe',
    args: { scope: 'tag', target: 'owner:src' },
    reply: subscribed(),
  },
  { label: 'scope spawned', tool: 'chat_subscribe', args: { scope: 'spawned' }, reply: subscribed() },
  {
    label: 'empty kinds list',
    tool: 'chat_subscribe',
    args: { scope: 'all', kinds: [] },
    reply: subscribed(),
  },
  { label: 'scope name, no target', tool: 'chat_subscribe', args: { scope: 'name' } },
  { label: 'scope tag, blank target', tool: 'chat_subscribe', args: { scope: 'tag', target: '  ' } },
  { label: 'scope omitted', tool: 'chat_subscribe', args: {} },
  { label: 'scope misspelled', tool: 'chat_subscribe', args: { scope: 'everyone' } },
  { label: 'unknown kind', tool: 'chat_subscribe', args: { scope: 'all', kinds: ['bogus'] } },
  {
    label: 'refused by the broker',
    tool: 'chat_subscribe',
    args: { scope: 'all' },
    reply: { t: 'subscribe_result', ok: false, held: 16, reason: 'at most 16 subscriptions' },
  },
  {
    label: 'kinds as a bare string',
    tool: 'chat_subscribe',
    args: { scope: 'all', kinds: 'agent_spawned' },
    reply: subscribed(),
  },
  { label: 'kinds null', tool: 'chat_subscribe', args: { scope: 'all', kinds: null }, reply: subscribed() },
  { label: 'a non-string target', tool: 'chat_subscribe', args: { scope: 'name', target: 42 } },
]

const CHAT_UNSUBSCRIBE_CASES: CallCase[] = [
  { label: 'everything', tool: 'chat_unsubscribe', args: {}, reply: subscribed(0) },
  {
    label: 'one rule',
    tool: 'chat_unsubscribe',
    args: { scope: 'name', target: 'bob' },
    reply: subscribed(1),
  },
  { label: 'scope spawned', tool: 'chat_unsubscribe', args: { scope: 'spawned' }, reply: subscribed(0) },
  { label: 'scope tag, no target', tool: 'chat_unsubscribe', args: { scope: 'tag' } },
  { label: 'scope misspelled', tool: 'chat_unsubscribe', args: { scope: 'everyone' } },
  { label: 'scope null', tool: 'chat_unsubscribe', args: { scope: null } },
]

const spawned = (extra: Partial<Extract<ServerMessage, { t: 'spawn_result' }>> = {}): ServerMessage => ({
  t: 'spawn_result',
  ok: true,
  agentId: 'a-1',
  name: 'scout',
  ...extra,
})

const SPAWN_ARGS = { name: 'scout', profile: 'explorer', brief: 'read the log' }
const ACCOUNT = { CLAUDE_CONFIG_DIR: '/home/me/.claude' }

const spawnCase = (
  label: string,
  args: Record<string, unknown>,
  extra: Partial<CallCase> = {},
): CallCase => ({
  label,
  tool: 'agent_spawn',
  registeredAs: 'me',
  env: ACCOUNT,
  args,
  ...extra,
})

function unregistered(c: CallCase): CallCase {
  const { registeredAs: _registeredAs, ...rest } = c
  return rest
}

const SPAWN_STRINGS = ['cwd', 'briefing', 'worktree', 'config_dir', 'resume_session', 'predecessor']

/** CC-106 S6: every optional string goes through `present()`, so a blank one leaves the frame as `optionalString` did. */
const AGENT_SPAWN_CASES: CallCase[] = [
  unregistered(spawnCase('unregistered', SPAWN_ARGS)),
  unregistered(spawnCase('unregistered, name missing', { profile: 'explorer', brief: 'b' })),
  spawnCase('minimal', SPAWN_ARGS, { reply: spawned() }),
  spawnCase('minimal, spawner has no config dir', SPAWN_ARGS, {
    env: { CLAUDE_CONFIG_DIR: undefined },
    reply: spawned(),
  }),
  spawnCase(
    'every override set',
    {
      ...SPAWN_ARGS,
      surface: 'iterm-pane',
      isolation: 'worktree',
      cwd: '/work/repo',
      briefing: 'claude-channels',
      worktree: '/work/repo/.worktrees/x',
      owns: ['src/broker/**', 'src/protocol.ts'],
      inherit: 'context',
      config_dir: '/home/me/.claude-profiles/agents',
      resume_session: 'uuid-1',
      predecessor: 'old-scout',
    },
    {
      reply: spawned({
        warnings: ['predecessor old-scout is not retired'],
        disallowedTools: ['Bash', 'Write'],
        transcript: { path: '/home/me/.claude/projects/x/uuid-1.jsonl', found: true },
      }),
    },
  ),
  ...SPAWN_STRINGS.map(field =>
    spawnCase(`blank ${field}`, { ...SPAWN_ARGS, [field]: '   ' }, { reply: spawned() }),
  ),
  spawnCase(
    'every optional string blank',
    Object.fromEntries([...Object.entries(SPAWN_ARGS), ...SPAWN_STRINGS.map(field => [field, ''])]),
    { reply: spawned() },
  ),
  spawnCase('owns trimmed, blanks dropped', { ...SPAWN_ARGS, owns: [' a ', ''] }, { reply: spawned() }),
  spawnCase('owns []', { ...SPAWN_ARGS, owns: [] }, { reply: spawned() }),
  spawnCase('owns 25 globs', { ...SPAWN_ARGS, owns: twentyFive }),
  spawnCase('owns as a bare string', { ...SPAWN_ARGS, owns: 'src/**' }, { reply: spawned() }),
  spawnCase('owns with a non-string item', { ...SPAWN_ARGS, owns: ['src/**', 42] }, { reply: spawned() }),
  spawnCase('surface misspelled', { ...SPAWN_ARGS, surface: 'iterm-panes' }),
  spawnCase('isolation misspelled', { ...SPAWN_ARGS, isolation: 'worktrees' }),
  spawnCase('inherit misspelled', { ...SPAWN_ARGS, inherit: 'everything' }),
  spawnCase('surface blank', { ...SPAWN_ARGS, surface: '  ' }),
  spawnCase('surface null', { ...SPAWN_ARGS, surface: null }, { reply: spawned() }),
  spawnCase('cwd not a string', { ...SPAWN_ARGS, cwd: 42 }, { reply: spawned() }),
  spawnCase('name blank', { ...SPAWN_ARGS, name: '  ' }),
  spawnCase('brief missing', { name: 'scout', profile: 'explorer' }),
  spawnCase('profile not a string', { ...SPAWN_ARGS, profile: 7 }),
  spawnCase('refused by the broker', SPAWN_ARGS, {
    reply: { t: 'spawn_result', ok: false, reason: 'name "scout" is taken' },
  }),
  spawnCase(
    'resumed with no transcript found',
    { ...SPAWN_ARGS, resume_session: 'uuid-2' },
    {
      reply: spawned({ transcript: { path: '/home/me/.claude/projects/x/uuid-2.jsonl', found: false } }),
    },
  ),
]

const teleported = (
  extra: Partial<Extract<ServerMessage, { t: 'teleport_result' }>> = {},
): ServerMessage => ({
  t: 'teleport_result',
  ok: true,
  agentId: 'a-2',
  name: 'me',
  ...extra,
})

const AGENT_TELEPORT_CASES: CallCase[] = [
  { label: 'unregistered', tool: 'agent_teleport', args: { handoff: 'h' } },
  { label: 'unregistered, handoff missing', tool: 'agent_teleport', args: {} },
  {
    label: 'visible, with a countdown and a warning',
    tool: 'agent_teleport',
    registeredAs: 'me',
    args: { handoff: 'mid-way through S6' },
    reply: teleported({ countdownMs: 30_000, warnings: ['dist is older than src'] }),
  },
  {
    label: 'headless, onto another model',
    tool: 'agent_teleport',
    registeredAs: 'me',
    args: { handoff: 'h', model: 'claude-sonnet-5' },
    reply: teleported(),
  },
  {
    label: 'blank model',
    tool: 'agent_teleport',
    registeredAs: 'me',
    args: { handoff: 'h', model: '  ' },
    reply: teleported(),
  },
  {
    label: 'refused by the broker',
    tool: 'agent_teleport',
    registeredAs: 'me',
    args: { handoff: 'h' },
    reply: { t: 'teleport_result', ok: false, reason: 'answer your open questions first' },
  },
  { label: 'handoff blank', tool: 'agent_teleport', registeredAs: 'me', args: { handoff: '  ' } },
  { label: 'handoff missing', tool: 'agent_teleport', registeredAs: 'me', args: {} },
  {
    label: 'model not a string',
    tool: 'agent_teleport',
    registeredAs: 'me',
    args: { handoff: 'h', model: 4 },
    reply: teleported(),
  },
]

async function render(c: CallCase): Promise<string> {
  for (const [key, value] of Object.entries(c.env ?? {})) vi.stubEnv(key, value)
  try {
    return await renderCall(c)
  } finally {
    vi.unstubAllEnvs()
  }
}

async function renderCall(c: CallCase): Promise<string> {
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
    ['chat_claim', CHAT_CLAIM_CASES],
    ['chat_release', CHAT_RELEASE_CASES],
    ['chat_tag', CHAT_TAG_CASES],
    ['chat_subscribe', CHAT_SUBSCRIBE_CASES],
    ['chat_unsubscribe', CHAT_UNSUBSCRIBE_CASES],
    ['agent_spawn', AGENT_SPAWN_CASES],
    ['agent_teleport', AGENT_TELEPORT_CASES],
  ])('%s answers every pinned case exactly as before', async (tool, cases) => {
    const rendered: string[] = []
    for (const c of cases) rendered.push(await render(c))

    await expect(rendered.join('\n')).toMatchFileSnapshot(`./golden/calls-${tool}.txt`)
  })
})
