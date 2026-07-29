import type { BrokerClient } from '../client/broker-client.js'
import { ISOLATION_NAMES, SESSION_STATUSES, SUBSCRIBABLE_KINDS, SURFACE_NAMES } from '../protocol.js'
import { terminalAnchor } from './anchor.js'
import { hostIdentity } from './host.js'
import { listProfileNames, loadProfile } from '../agents/profiles.js'
import { transcriptLine } from '../agents/transcript.js'
import type {
  DeliveredMessage,
  QueueItem,
  ServerMessage,
  SessionInfo,
  SessionStatus,
  SubscribableKind,
  SubscriptionSelector,
} from '../protocol.js'

/**
 * The MCP SDK does not enforce `required` or `enum` on inbound arguments, so a
 * model that omits a field reaches the handler with `undefined`. `String(undefined)`
 * is the non-empty string "undefined", which passes every downstream check — the
 * broker routes it, logs it, and answers ok:true while the recipient is delivered
 * the word "undefined". Observed live on 2026-07-27. Validate at the boundary.
 */
function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${key} is required and must be a non-empty string`)
  }
  return value
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * An absent optional enum is fine; a misspelled one is not. Declaring `enum` in the
 * schema does not enforce it (see above), and silently dropping an unrecognised
 * value would spawn onto the profile default while the caller believes it asked
 * for something else — a headless agent where it wanted an answerable pane.
 */
function optionalEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${key} must be one of: ${allowed.join(', ')}`)
  }
  return value as T
}

/** Upper bound on a replay request, so one tool call cannot flood a session's context. */
const INBOX_MAX = 50

/** Number(undefined) is NaN, which JSON.stringify sends over the wire as null. */
function boundedLimit(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const value = args[key]
  if (value === undefined || value === null) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${key} must be a positive number`)
  }
  return Math.min(Math.floor(parsed), max)
}

function requireStatus(args: Record<string, unknown>): SessionStatus {
  const value = args.status
  if (typeof value !== 'string' || !(SESSION_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`status must be one of: ${SESSION_STATUSES.join(', ')}`)
  }
  return value as SessionStatus
}

export const TOOL_DEFINITIONS = [
  {
    name: 'chat_register',
    description:
      'Announce this session to other Claude sessions on this machine. Call once at the start of the session. ' +
      'The name is how others address you and is held until this session exits.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short handle for this session, e.g. "voltras-ui"' },
        working_on: { type: 'string', description: 'One line on what this session is doing' },
      },
      required: ['name'],
    },
  },
  {
    name: 'chat_status',
    description:
      'Update what this session is doing and whether it is free to take work. Set dnd to hold ' +
      'incoming pushes when you need a long stretch of focus: nothing is lost, messages collect ' +
      'in your inbox and chat_inbox returns them whenever you next look. Your user can still ' +
      'reach you; other sessions cannot.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['working', 'available', 'blocked'] },
        working_on: { type: 'string', description: 'Optional new description of current work' },
        dnd: {
          type: 'boolean',
          description: 'Hold pushes from other sessions until you clear it. Independent of status.',
        },
      },
      required: ['status'],
    },
  },
  {
    name: 'chat_list',
    description: 'List the Claude sessions currently registered, with status and what each is working on.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'chat_send',
    description:
      'Send a message to one other registered session by name. Fire-and-forget: the recipient sees it on ' +
      'their next turn and there is no reply unless they send one. Pass in_reply_to with a msg_id to answer ' +
      "a message. A successful send means the message reached the recipient's session process — NOT that " +
      'the recipient read or acted on it. Before sending a claim, quote what you OBSERVED rather than what ' +
      'you CONCLUDED: the raw log line, the exact output. A peer can check evidence; they cannot check your ' +
      'inference, and a wrong conclusion travels further than the observation that would refute it.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Registered name of the recipient session' },
        text: { type: 'string', description: 'Message body' },
        in_reply_to: { type: 'string', description: 'msg_id of the message being answered, if any' },
      },
      required: ['to', 'text'],
    },
  },
  {
    name: 'chat_activity',
    description:
      'See what another session has been doing without interrupting it. This is a read: it puts ' +
      'nothing into that session and costs it nothing, so prefer it over messaging a peer to ask ' +
      'what it is up to. Shows bus activity — messages, status changes, permission prompts — not ' +
      'the work itself, and it still answers for a session that has already exited.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Registered name of the session to look at' },
        limit: { type: 'number', description: 'How many recent events to show (default 15)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'chat_broadcast',
    description:
      'Send a message to every registered session except this one. Use sparingly: the cost is ' +
      'the message times the number of sessions, and each one is a derailed turn. The bus is ' +
      'machine-wide, so recipients include sessions on unrelated initiatives with no stake in ' +
      'your work. Past a budget a broadcast is held in recipients’ inboxes instead of being ' +
      'pushed, so prefer chat_send to the sessions that actually need it.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Message body' } },
      required: ['text'],
    },
  },
  {
    name: 'chat_ask',
    description:
      'Ask the human a question and stop waiting on it. Use ONLY when you genuinely cannot proceed and no ' +
      'reasonable default exists — prefer deciding and saying what you assumed. The answer arrives later as a ' +
      'channel message, so continue with other work meanwhile. You may have at most 3 unanswered questions.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The question, with enough context to answer it cold' },
      },
      required: ['text'],
    },
  },
  {
    name: 'chat_notify',
    description:
      'Leave the human a status notice that needs no answer, e.g. finishing a long task or hitting something ' +
      'they should know about. It waits in their queue; it does not interrupt them.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'One line worth their attention' } },
      required: ['text'],
    },
  },
  {
    name: 'chat_inbox',
    description:
      'Re-read recent messages sent to this session. Useful if several arrived at once or one was missed.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many recent messages to return (default 10)' },
      },
    },
  },
  {
    name: 'chat_subscribe',
    description:
      'Ask to be told when sessions and agents come and go. Scope it: "name" for one agent, "tag" for ' +
      'everything carrying a tag, or "all" — which is genuinely noisy on a busy bus and worth avoiding ' +
      'unless you are coordinating. Events arrive batched and marked from agent-chat, and are LIFECYCLE ' +
      'ONLY: you learn who is here, never what anyone said. Re-subscribing with the same scope replaces ' +
      'that rule rather than adding a second one. Subscriptions last as long as this session.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['all', 'name', 'tag'],
          description: 'What to watch. "name" and "tag" need target set.',
        },
        target: { type: 'string', description: 'The agent name, or the tag. Omit only for scope "all".' },
        kinds: {
          type: 'array',
          items: { type: 'string', enum: [...SUBSCRIBABLE_KINDS] },
          description: `Which events. Defaults to joins and leaves. One of: ${SUBSCRIBABLE_KINDS.join(', ')}`,
        },
      },
      required: ['scope'],
    },
  },
  {
    name: 'chat_unsubscribe',
    description:
      'Stop being told. Pass the same scope and target to drop one rule, or no arguments at all to drop ' +
      'every subscription this session holds.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['all', 'name', 'tag'] },
        target: { type: 'string' },
      },
    },
  },
  {
    name: 'agent_spawn',
    description:
      'Spawn a durable agent that runs as its own Claude Code session and joins the bus as an ordinary ' +
      'peer, addressable by name with chat_send. Register first — the spawn is attributed to you, and a ' +
      'visible agent is placed in YOUR terminal, which the broker resolves from your own registration ' +
      'rather than from anything you pass here. The agent outlives this session: it belongs to the ' +
      'broker, not to you, so spawning is not a way to get work done before your turn ends. The profile ' +
      'decides the model, the tool set and where the agent appears — read agent_profiles before choosing ' +
      'one, and prefer the narrowest that fits. Spawn because work genuinely needs a second, longer-lived ' +
      'context, not to parallelise something you could finish yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Short handle for the agent, e.g. "auth-review". Must be free.',
        },
        profile: { type: 'string', description: 'Profile name; see agent_profiles for what each grants.' },
        brief: {
          type: 'string',
          description:
            'What the agent should do, in full. It starts with only this — it does not inherit your ' +
            'conversation, so state the task, the context needed to act, and what to report back.',
        },
        surface: {
          type: 'string',
          enum: [...SURFACE_NAMES],
          description:
            "Overrides the profile's surface. Visible surfaces land in your window and can answer " +
            'permission prompts; headless cannot be prompted at all.',
        },
        isolation: {
          type: 'string',
          enum: [...ISOLATION_NAMES],
          description: "Overrides the profile's isolation, e.g. worktree to keep it out of your checkout.",
        },
        cwd: { type: 'string', description: 'Working directory. Defaults to yours.' },
      },
      required: ['name', 'profile', 'brief'],
    },
  },
  {
    name: 'agent_teleport',
    description:
      'End this session and start a successor that boots from the CURRENT build, keeping your name, ' +
      'your peers, your tags and your working directory. Use it when your own instructions or the code ' +
      'you run on have moved since you started — the alternative is exiting (losing what you know) or ' +
      'staying useful and stale. BUILD FIRST: the successor execs whatever `npm run build` last ' +
      'produced, so a teleport that skips the build achieves nothing at real cost. This is not a resume ' +
      'and not a subagent: your transcript does not come with you, the handoff below is all your ' +
      'successor gets, and you will be shut down. If you are visible in a terminal, your human gets 30 ' +
      'seconds to stop it; if you are headless it happens immediately. You cannot cancel it yourself. ' +
      'Answer or dismiss any open questions to the human first — teleport refuses while any are open.',
    inputSchema: {
      type: 'object',
      properties: {
        handoff: {
          type: 'string',
          description:
            'Everything your successor needs, written by you, stored verbatim, 8 KB max (refused, not ' +
            'truncated). Cover, in this order: (1) what you were mid-way through, in enough detail to ' +
            'resume without you; (2) state on disk — branch, uncommitted files, what builds and what ' +
            'does not; (3) what you would have done next, and why that and not the alternative; (4) ' +
            'what you already tried that did NOT work, which is the most expensive thing to lose; (5) ' +
            'who you owe a reply to and what you promised; (6) files to read first, in order, as ' +
            '@-prefixed absolute paths — Claude Code expands those into your successor’s first turn, ' +
            'so point at files instead of pasting them.',
        },
        model: {
          type: 'string',
          description:
            'Optional. Omit to keep running on the model you are on now, which is the usual case. Set ' +
            'it only to succeed yourself onto a different one deliberately — a cheaper model for a ' +
            'long grind, a stronger one for what is left.',
        },
      },
      required: ['handoff'],
    },
  },
  {
    name: 'agent_surface',
    description:
      'Pull a HEADLESS agent into a terminal window where your human can see it and answer it. Use ' +
      'this when a headless agent has gone quiet or looks stuck: a headless session is never shown a ' +
      'permission prompt, so anything it needed approval for was silently denied and it has no way to ' +
      'tell you that is what happened. Surfacing is the fix — the agent comes back with its name, its ' +
      'identity and its whole conversation intact, in a window. If you are in a terminal yourself it ' +
      'opens beside you in the same window; if you are headless it opens its own. COST, and say so if ' +
      'you report this: the agent is stopped and resumed, so whatever turn it was part way through is ' +
      'lost. Refused for an agent already in a terminal — agent_list shows where each one is.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The headless agent to bring up, as shown by agent_list.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'agent_background',
    description:
      'Send YOURSELF headless, releasing the terminal window you are in. This names no agent and ' +
      'cannot be aimed at one: you may only background yourself. Your name, identity and conversation ' +
      'all survive. Understand what you are giving up before calling it — headless sessions are never ' +
      'shown permission prompts, so anything needing approval will be denied outright rather than ' +
      'asked about, and nobody is watching a pane for you. Do not background yourself while you are ' +
      'blocked on something, or expect to be.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'agent_profiles',
    description:
      'List the profiles agent_spawn can use, with the model, tool set, surface and isolation each grants. ' +
      'Read this before spawning rather than guessing a profile name.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'agent_list',
    description:
      'List durable agents with their lifecycle state and whether a process is currently attached. ' +
      'An agent can exist without being connected — identity outlives presence.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] })

/** Joins and leaves — what someone asking to be told about comings and goings means. */
const DEFAULT_SUBSCRIBED_KINDS: SubscribableKind[] = [
  'registered',
  'deregistered',
  'agent_attached',
  'agent_detached',
]

const describe = (selector: SubscriptionSelector): string =>
  'all' in selector ? 'everything' : 'name' in selector ? `agent "${selector.name}"` : `tag "${selector.tag}"`

const ago = (ms: number): string =>
  ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`

function formatSessions(sessions: SessionInfo[], self: string | null): string {
  if (sessions.length === 0) return 'No sessions are registered.'
  const rows = sessions.map(s => {
    const you = s.name === self ? ' (you)' : ''
    const quiet = s.dnd ? ', dnd' : ''
    return `- ${s.name}${you} [${s.status}${quiet}, idle ${ago(s.idleMs)}] — ${s.workingOn || 'no description'}\n    ${s.cwd}`
  })
  return `Active sessions:\n${rows.join('\n')}`
}

function formatActivity(name: string, session: SessionInfo | undefined, events: QueueItem[]): string {
  const header = session
    ? `${name} [${session.status}, idle ${ago(session.idleMs)}] — ${session.workingOn || 'no description'}\n  ${session.cwd}`
    : `${name} is not currently registered. Last known activity below.`
  if (events.length === 0) return `${header}\n\nNothing on the bus yet.`

  const rows = events.map(e => {
    // Direction is the useful thing at a glance: what it did vs what landed on it.
    const arrow = e.from === name ? `-> ${e.meta.target ?? '?'}` : `<- ${e.from}`
    const body = e.text.replace(/\s+/g, ' ').slice(0, 90)
    return `  ${ago(Date.now() - e.at).padStart(4)} ago  ${e.kind.padEnd(16)} ${arrow.padEnd(14)} ${body}`
  })
  return `${header}\n\nRecent bus activity (this read did not notify ${name}):\n${rows.join('\n')}`
}

function formatInbox(messages: DeliveredMessage[]): string {
  if (messages.length === 0) return 'No messages yet.'
  const rows = messages.map(m => {
    const tags = [m.broadcast ? 'broadcast' : null, m.inReplyTo ? `re ${m.inReplyTo}` : null].filter(Boolean)
    const suffix = tags.length > 0 ? ` (${tags.join(', ')})` : ''
    return `- [${m.msgId}] from ${m.from}${suffix}: ${m.text}`
  })
  return `Recent messages:\n${rows.join('\n')}`
}

/** Tracks the registered name purely so chat_list can mark which entry is us. */
export class ToolHandler {
  private registeredName: string | null
  /** True when the name came from the spawn environment rather than the model. */
  private readonly nameIsFixed: boolean

  /**
   * `spawnedName` seeds the handler for an agent the broker already registered
   * from its environment. Without it the broker knows the agent's name and the
   * handler does not, so `chat_send` would refuse with "call chat_register
   * first" while the agent looked perfectly registered to every peer — visible
   * to everyone, able to answer no one.
   */
  constructor(
    private readonly broker: BrokerClient,
    spawnedName?: string,
  ) {
    this.registeredName = spawnedName ?? null
    this.nameIsFixed = spawnedName !== undefined
  }

  private async call(
    message: Parameters<BrokerClient['request']>[0],
    replyType: Parameters<BrokerClient['request']>[1],
  ) {
    return this.broker.request(message, replyType)
  }

  async handle(name: string, args: Record<string, unknown>) {
    switch (name) {
      case 'chat_register':
        return this.register(requireString(args, 'name'), optionalString(args, 'working_on') ?? '')
      case 'chat_status':
        return this.status(
          requireStatus(args),
          optionalString(args, 'working_on'),
          typeof args.dnd === 'boolean' ? args.dnd : undefined,
        )
      case 'chat_list':
        return this.list()
      case 'chat_activity':
        return this.activity(requireString(args, 'name'), boundedLimit(args, 'limit', 15, INBOX_MAX))
      case 'chat_send':
        return this.send(
          requireString(args, 'to'),
          requireString(args, 'text'),
          optionalString(args, 'in_reply_to'),
        )
      case 'chat_broadcast':
        return this.broadcast(requireString(args, 'text'))
      case 'chat_ask':
        return this.toHuman('ask', requireString(args, 'text'))
      case 'chat_notify':
        return this.toHuman('notify', requireString(args, 'text'))
      case 'chat_inbox':
        return this.inbox(boundedLimit(args, 'limit', 10, INBOX_MAX))
      case 'chat_subscribe':
        return this.subscribe(args)
      case 'chat_unsubscribe':
        return this.unsubscribe(args)
      case 'agent_spawn':
        return this.spawnAgent(args)
      case 'agent_teleport':
        return this.teleport(args)
      case 'agent_surface':
        return this.surfaceAgent(args)
      case 'agent_background':
        return this.backgroundSelf()
      case 'agent_profiles':
        return this.agentProfiles()
      case 'agent_list':
        return this.agentList()
      default:
        throw new Error(`unknown tool: ${name}`)
    }
  }

  private async register(name: string, workingOn: string) {
    // A spawned agent was named by whoever spawned it, and peers have already
    // been told that name. Letting the model rename itself mid-session would
    // strand every one of them, so the call is a no-op rather than a rename.
    if (this.nameIsFixed) {
      if (name === this.registeredName)
        return text(`Already registered as "${name}" by the agent that spawned you.`)
      return text(
        `You are already registered as "${this.registeredName}" (spawned agent); ` +
          'that name is fixed for this session.',
      )
    }

    const res = (await this.call(
      {
        t: 'register',
        name,
        workingOn,
        cwd: process.cwd(),
        pid: process.pid,
        // The half of this registration the model did not choose. `name` and
        // `workingOn` above came from the model; these came from the process,
        // which is what lets the broker mint an identity for an ordinary session
        // without that identity being self-asserted.
        ...hostIdentity(),
        ...terminalAnchor(),
      },
      'register_result',
    )) as Extract<ServerMessage, { t: 'register_result' }>
    if (!res.ok) return text(`Registration failed: ${res.reason}`)
    this.registeredName = name
    return text(
      `Registered as "${name}". Other sessions can reach you by that name until this session exits.`,
    )
  }

  private async status(status: SessionStatus, workingOn?: string, dnd?: boolean) {
    const res = (await this.call(
      {
        t: 'status',
        status,
        ...(workingOn === undefined ? {} : { workingOn }),
        ...(dnd === undefined ? {} : { dnd }),
      },
      'status_result',
    )) as Extract<ServerMessage, { t: 'status_result' }>
    if (!res.ok) return text('Call chat_register first.')
    const quiet =
      dnd === undefined
        ? ''
        : dnd
          ? ' Holding pushes from other sessions; they collect in your inbox.'
          : ' Taking pushes again.'
    return text(`Status set to "${status}".${quiet}`)
  }

  private async list() {
    const res = (await this.call({ t: 'list' }, 'list_result')) as Extract<
      ServerMessage,
      { t: 'list_result' }
    >
    return text(formatSessions(res.sessions, this.registeredName))
  }

  private async activity(name: string, limit: number) {
    const res = (await this.call({ t: 'activity', name, limit }, 'activity_result')) as Extract<
      ServerMessage,
      { t: 'activity_result' }
    >
    if (!res.session && res.events.length === 0) {
      return text(`No session named "${name}" is registered, and nothing in the log mentions it.`)
    }
    return text(formatActivity(name, res.session, res.events))
  }

  private async send(to: string, body: string, inReplyTo?: string) {
    if (!this.registeredName)
      return text('Call chat_register before sending, so the recipient knows who you are.')
    const res = (await this.call(
      { t: 'send', to, text: body, ...(inReplyTo === undefined ? {} : { inReplyTo }) },
      'send_result',
    )) as Extract<ServerMessage, { t: 'send_result' }>
    if (!res.ok) return text(`Not delivered: ${res.reason}`)
    if (res.held) return text(`Held for "${to}" (msg_id ${res.msgId}): ${res.reason}`)
    return text(`Delivered to "${to}" (msg_id ${res.msgId}).`)
  }

  private async broadcast(body: string) {
    if (!this.registeredName) return text('Call chat_register before broadcasting.')
    const res = (await this.call({ t: 'broadcast', text: body }, 'send_result')) as Extract<
      ServerMessage,
      { t: 'send_result' }
    >
    if (!res.ok) return text(`Not delivered: ${res.reason}`)
    if (res.recipients.length === 0) return text('No other sessions are registered, so nobody received it.')
    if (res.held) return text(`Held for ${res.recipients.join(', ')}: ${res.reason}`)
    return text(`Broadcast to ${res.recipients.join(', ')} (msg_id ${res.msgId}).`)
  }

  private async toHuman(kind: 'ask' | 'notify', body: string) {
    if (!this.registeredName) return text('Call chat_register first.')
    const res = (await this.call({ t: kind, text: body }, 'send_result')) as Extract<
      ServerMessage,
      { t: 'send_result' }
    >
    if (!res.ok) return text(`Not queued: ${res.reason}`)
    return text(
      kind === 'ask'
        ? `Question queued for the human (msg_id ${res.msgId}). They may not see it for a while — carry on with other work.`
        : `Notice left for the human (msg_id ${res.msgId}).`,
    )
  }

  private async inbox(limit: number) {
    const res = (await this.call({ t: 'inbox', limit }, 'inbox_result')) as Extract<
      ServerMessage,
      { t: 'inbox_result' }
    >
    return text(formatInbox(res.messages))
  }

  /**
   * "all" needs no target; "name" and "tag" are meaningless without one. Caught
   * here because the MCP SDK enforces neither, and a scope silently defaulting to
   * global is the one mistake that turns a quiet bus into a loud one.
   */
  private selectorFrom(args: Record<string, unknown>): SubscriptionSelector {
    const scope = optionalEnum(args, 'scope', ['all', 'name', 'tag'] as const)
    if (scope === undefined) throw new Error('scope is required and must be one of: all, name, tag')
    if (scope === 'all') return { all: true }
    const target = optionalString(args, 'target')
    if (target === undefined) throw new Error(`scope "${scope}" needs target set to the ${scope} to watch`)
    return scope === 'name' ? { name: target } : { tag: target }
  }

  private async subscribe(args: Record<string, unknown>) {
    const selector = this.selectorFrom(args)
    const raw = args.kinds
    const kinds = Array.isArray(raw) ? raw : DEFAULT_SUBSCRIBED_KINDS
    for (const kind of kinds) {
      if (typeof kind !== 'string' || !(SUBSCRIBABLE_KINDS as readonly string[]).includes(kind)) {
        throw new Error(`kinds must all be one of: ${SUBSCRIBABLE_KINDS.join(', ')}`)
      }
    }

    const res = (await this.call(
      { t: 'subscribe', subscriptions: [{ selector, kinds: kinds as SubscribableKind[] }] },
      'subscribe_result',
    )) as Extract<ServerMessage, { t: 'subscribe_result' }>
    if (!res.ok) return text(`Not subscribed: ${res.reason}`)
    return text(`Subscribed to ${describe(selector)} for ${kinds.join(', ')}. Holding ${res.held}.`)
  }

  private async unsubscribe(args: Record<string, unknown>) {
    const all = args.scope === undefined
    const res = (await this.call(
      { t: 'unsubscribe', ...(all ? {} : { selector: this.selectorFrom(args) }) },
      'subscribe_result',
    )) as Extract<ServerMessage, { t: 'subscribe_result' }>
    return text(
      all
        ? `Dropped every subscription. Holding ${res.held}.`
        : `Unsubscribed from ${describe(this.selectorFrom(args))}. Holding ${res.held}.`,
    )
  }

  /**
   * The anchor is deliberately absent from the request. The broker resolves it
   * from THIS session's registry entry, so a spawn cannot be aimed at a pane the
   * caller does not hold — and passing one here would be ignored anyway (§5.4).
   */
  private async spawnAgent(args: Record<string, unknown>) {
    if (this.registeredName === null) {
      return text(
        'Register with chat_register first: a spawn is attributed to the session that asked for it.',
      )
    }
    const surface = optionalEnum(args, 'surface', SURFACE_NAMES)
    const isolation = optionalEnum(args, 'isolation', ISOLATION_NAMES)
    const cwd = optionalString(args, 'cwd')
    const res = (await this.call(
      {
        t: 'spawn',
        name: requireString(args, 'name'),
        profile: requireString(args, 'profile'),
        brief: requireString(args, 'brief'),
        ...(surface === undefined ? {} : { surface }),
        ...(isolation === undefined ? {} : { isolation }),
        ...(cwd === undefined ? {} : { cwd }),
      },
      'spawn_result',
    )) as Extract<ServerMessage, { t: 'spawn_result' }>

    if (!res.ok) return text(`Not spawned: ${res.reason}`)
    const warnings = (res.warnings ?? []).map(w => `\n  warning: ${w}`).join('')
    return text(
      `Spawned "${res.name}" (${res.agentId}). It is a peer now — reach it with chat_send, ` +
        `not by spawning again.${warnings}`,
    )
  }

  /**
   * Hand off and end this session.
   *
   * Nothing here names the subject: the broker resolves it from this
   * connection's own registry entry, which is what makes "teleport someone else"
   * unrepresentable rather than merely refused.
   */
  private async teleport(args: Record<string, unknown>) {
    if (this.registeredName === null) {
      return text(
        'Register with chat_register first: teleport hands your name to a successor, and you do not ' +
          'have one yet.',
      )
    }
    const model = optionalString(args, 'model')
    const res = (await this.call(
      { t: 'teleport', handoff: requireString(args, 'handoff'), ...(model === undefined ? {} : { model }) },
      'teleport_result',
    )) as Extract<ServerMessage, { t: 'teleport_result' }>

    if (!res.ok) return text(`Not teleporting: ${res.reason}`)
    const warnings = (res.warnings ?? []).map(w => `\n  warning: ${w}`).join('')
    const when =
      res.countdownMs === undefined
        ? 'Your successor is starting now and this session is being shut down.'
        : `Your human has ${Math.round(res.countdownMs / 1000)}s to stop this, then you will be shut ` +
          'down and your successor will open in the same window.'
    return text(
      `Teleport accepted. Handoff recorded; your successor is ${res.agentId} and keeps the name ` +
        `"${res.name}". ${when} Do not start anything new — finish or write down whatever is in ` +
        `flight, because it will not survive this turn.${warnings}`,
    )
  }

  private async surfaceAgent(args: Record<string, unknown>) {
    const name = requireString(args, 'name')
    const res = (await this.call({ t: 'surface', name }, 'switch_result')) as Extract<
      ServerMessage,
      { t: 'switch_result' }
    >
    if (!res.ok) return text(`Not surfacing ${name}: ${res.reason}`)
    // Where it LANDED, not where it was asked to go: the iTerm ladder downgrades
    // to a new window when an anchor is gone, and telling the human to look in
    // the wrong place is the failure this whole feature exists to prevent.
    const where =
      res.surface === 'iterm-window'
        ? 'a new iTerm window'
        : res.surface === 'iterm-tab'
          ? 'a new iTerm tab'
          : 'a pane in your window'
    return text(
      `${res.name} is now in ${where}, resumed on its existing conversation and keeping its name. ` +
        'The turn it was part way through was interrupted by the switch. If it was stuck on a ' +
        'permission prompt, that prompt is answerable there now — tell your human to look.',
    )
  }

  private async backgroundSelf() {
    if (this.registeredName === null)
      return text(
        'Register with chat_register first: going headless keeps your identity, and you have none yet.',
      )
    const res = (await this.call({ t: 'background' }, 'switch_result')) as Extract<
      ServerMessage,
      { t: 'switch_result' }
    >
    if (!res.ok) return text(`Not going headless: ${res.reason}`)
    return text(
      'Going headless. This session is being shut down and resumed without a window, keeping your ' +
        'name and your conversation. Do not start anything new — the turn you are in now will not ' +
        'survive it.',
    )
  }

  private agentProfiles() {
    const rows = listProfileNames().map(name => {
      const profile = loadProfile(name)
      if ('error' in profile) return `- ${name}: unreadable (${profile.error})`
      return (
        `- ${name} [${profile.model}, ${profile.surface}, isolation ${profile.isolation}]\n` +
        `    ${profile.description}\n    tools: ${profile.allowedTools.join(', ')}`
      )
    })
    return text(
      rows.length === 0 ? 'No profiles available.' : `Profiles for agent_spawn:\n${rows.join('\n')}`,
    )
  }

  private async agentList() {
    const res = (await this.call({ t: 'agents' }, 'agents_result')) as Extract<
      ServerMessage,
      { t: 'agents_result' }
    >
    if (res.agents.length === 0) return text('No agents.')
    const rows = res.agents.map(
      a =>
        // An adopted identity has no profile and no surface we chose, and its
        // name is self-reported — so it says what it is rather than rendering
        // two empty fields and reading like an agent someone spawned.
        `- ${a.name} [${a.state}, ${a.origin === 'adopted' ? 'human-started session' : `${a.profile}, ${a.surface}`}]` +
        ` spawned by ${a.spawnedBy}\n    ${a.cwd}` +
        // A headless agent's output is discarded, so this is the only way to read
        // what it actually did without interrupting it for a report.
        `\n    ${transcriptLine(a.cwd, a.sessionId)}`,
    )
    return text(`Durable agents:\n${rows.join('\n')}`)
  }
}
