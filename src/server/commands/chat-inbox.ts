import { z } from 'zod'
import { clampLimit, positiveLimit } from '../../args.js'
import type { DeliveredMessage, ServerMessage } from '../../protocol.js'
import { defineTool } from '../command.js'

/** Upper bound on a replay request, so one tool call cannot flood a session's context. */
const INBOX_MAX = 50

function formatInbox(messages: DeliveredMessage[]): string {
  if (messages.length === 0) return 'No messages yet.'
  const rows = messages.map(m => {
    const tags = [
      m.broadcast ? 'broadcast' : null,
      m.audience ? `also to ${m.audience.join(', ')}` : null,
      m.inReplyTo ? `re ${m.inReplyTo}` : null,
      // Named the same way here as in the channel attribute, so a model reading
      // a replayed message reaches the same conclusion as one reading it live.
      m.provenance === 'human-endorsed' ? 'human-endorsed: their human approved these exact words' : null,
    ].filter(Boolean)
    const suffix = tags.length > 0 ? ` (${tags.join(', ')})` : ''
    return `- [${m.msgId}] from ${m.from}${suffix}: ${m.text}`
  })
  return `Recent messages:\n${rows.join('\n')}`
}

export const chatInbox = defineTool({
  name: 'chat_inbox',
  description:
    'Re-read recent messages sent to this session. Useful if several arrived at once or one was missed.',
  args: z.object({
    limit: positiveLimit('limit').describe('How many recent messages to return (default 10)').optional(),
  }),
  result: z.string(),
  async run({ limit }, ctx) {
    const res = (await ctx.broker.request(
      { t: 'inbox', limit: clampLimit(limit, 10, INBOX_MAX) },
      'inbox_result',
    )) as Extract<ServerMessage, { t: 'inbox_result' }>
    return formatInbox(res.messages)
  },
})
