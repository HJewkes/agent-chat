import type { BrokerClient } from '../client/broker-client.js'
import type { DeliveredMessage, ServerMessage, SessionInfo, SessionStatus } from '../protocol.js'

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
    description: 'Update what this session is doing and whether it is free to take work.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['working', 'available', 'blocked'] },
        working_on: { type: 'string', description: 'Optional new description of current work' },
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
      'their next turn and there is no reply unless they send one. Pass in_reply_to with a msg_id to answer a message.',
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
    name: 'chat_broadcast',
    description: 'Send a message to every registered session except this one. Use sparingly.',
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
    return `- ${s.name}${you} [${s.status}, idle ${ago(s.idleMs)}] — ${s.workingOn || 'no description'}\n    ${s.cwd}`
  })
  return `Active sessions:\n${rows.join('\n')}`
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
  private registeredName: string | null = null

  constructor(private readonly broker: BrokerClient) {}

  private async call(
    message: Parameters<BrokerClient['request']>[0],
    replyType: Parameters<BrokerClient['request']>[1],
  ) {
    return this.broker.request(message, replyType)
  }

  async handle(name: string, args: Record<string, unknown>) {
    switch (name) {
      case 'chat_register':
        return this.register(String(args.name), String(args.working_on ?? ''))
      case 'chat_status':
        return this.status(args.status as SessionStatus, args.working_on as string | undefined)
      case 'chat_list':
        return this.list()
      case 'chat_send':
        return this.send(String(args.to), String(args.text), args.in_reply_to as string | undefined)
      case 'chat_broadcast':
        return this.broadcast(String(args.text))
      case 'chat_ask':
        return this.toHuman('ask', String(args.text))
      case 'chat_notify':
        return this.toHuman('notify', String(args.text))
      case 'chat_inbox':
        return this.inbox(Number(args.limit ?? 10))
      default:
        throw new Error(`unknown tool: ${name}`)
    }
  }

  private async register(name: string, workingOn: string) {
    const res = (await this.call(
      { t: 'register', name, workingOn, cwd: process.cwd(), pid: process.pid },
      'register_result',
    )) as Extract<ServerMessage, { t: 'register_result' }>
    if (!res.ok) return text(`Registration failed: ${res.reason}`)
    this.registeredName = name
    return text(
      `Registered as "${name}". Other sessions can reach you by that name until this session exits.`,
    )
  }

  private async status(status: SessionStatus, workingOn?: string) {
    const res = (await this.call(
      { t: 'status', status, ...(workingOn === undefined ? {} : { workingOn }) },
      'status_result',
    )) as Extract<ServerMessage, { t: 'status_result' }>
    return text(res.ok ? `Status set to "${status}".` : 'Call chat_register first.')
  }

  private async list() {
    const res = (await this.call({ t: 'list' }, 'list_result')) as Extract<
      ServerMessage,
      { t: 'list_result' }
    >
    return text(formatSessions(res.sessions, this.registeredName))
  }

  private async send(to: string, body: string, inReplyTo?: string) {
    if (!this.registeredName)
      return text('Call chat_register before sending, so the recipient knows who you are.')
    const res = (await this.call(
      { t: 'send', to, text: body, ...(inReplyTo === undefined ? {} : { inReplyTo }) },
      'send_result',
    )) as Extract<ServerMessage, { t: 'send_result' }>
    return text(res.ok ? `Delivered to "${to}" (msg_id ${res.msgId}).` : `Not delivered: ${res.reason}`)
  }

  private async broadcast(body: string) {
    if (!this.registeredName) return text('Call chat_register before broadcasting.')
    const res = (await this.call({ t: 'broadcast', text: body }, 'send_result')) as Extract<
      ServerMessage,
      { t: 'send_result' }
    >
    if (!res.ok) return text(`Not delivered: ${res.reason}`)
    if (res.recipients.length === 0) return text('No other sessions are registered, so nobody received it.')
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
