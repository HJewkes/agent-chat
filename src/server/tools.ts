import type { BrokerClient } from '../client/broker-client.js'
import { SESSION_STATUSES } from '../protocol.js'
import { terminalAnchor } from './anchor.js'
import type { DeliveredMessage, QueueItem, ServerMessage, SessionInfo, SessionStatus } from '../protocol.js'

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
] as const

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] })

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
      { t: 'register', name, workingOn, cwd: process.cwd(), pid: process.pid, ...terminalAnchor() },
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
}
