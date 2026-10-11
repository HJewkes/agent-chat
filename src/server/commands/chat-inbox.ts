import { z } from 'zod'
import { clampLimit, positiveLimit } from '../../args.js'
import type { DeliveredMessage, ServerMessage } from '../../protocol.js'
import { defineTool } from '../command.js'
import { withHint } from '../context-hint.js'

/** Upper bound on a replay request, so one tool call cannot flood a session's context. */
const INBOX_MAX = 50

function formatInbox(messages: DeliveredMessage[], after?: string): string {
  if (messages.length === 0) return after ? `No messages after ${after}.` : 'No messages yet.'
  const rows = messages.map(m => {
    const tags = [
      m.broadcast ? 'broadcast' : null,
      m.audience ? `also to ${m.audience.join(', ')}` : null,
      m.inReplyTo ? `re ${m.inReplyTo}` : null,
      // Named the same way here as in the channel attribute, so a model reading
      // a replayed message reaches the same conclusion as one reading it live.
      m.provenance === 'human-endorsed' ? 'human-endorsed: their human approved these exact words' : null,
      m.provenance === 'decided'
        ? 'decided: answers your question on your human’s behalf; they may overrule'
        : null,
      m.event === 'overrule' ? 'overrule: your human replaced an earlier decision' : null,
    ].filter(Boolean)
    const suffix = tags.length > 0 ? ` (${tags.join(', ')})` : ''
    return `- [${m.msgId}] from ${m.from}${suffix}: ${m.text}`
  })
  return `${after ? 'Messages' : 'Recent messages'}:\n${rows.join('\n')}`
}

export const chatInbox = defineTool({
  name: 'chat_inbox',
  description:
    'Re-read recent messages sent to this session. Useful if several arrived at once or one was missed. ' +
    'Pass after: <msg_id> to get only what arrived after that message, oldest first, instead of the newest N.',
  args: z.object({
    limit: positiveLimit('limit').describe('How many recent messages to return (default 10)').optional(),
    after: z
      .string()
      .min(1)
      .describe(
        'A msg_id from this inbox. Returns only messages newer than it, oldest first, capped by limit ' +
          '(default 50); a truncation note gives the msg_id to continue from. Unknown ids are an error.',
      )
      .optional(),
  }),
  result: z.string(),
  async run({ limit, after }, ctx) {
    const res = (await ctx.broker.request(
      after === undefined
        ? { t: 'inbox', limit: clampLimit(limit, 10, INBOX_MAX) }
        : { t: 'inbox', limit: clampLimit(limit, INBOX_MAX, INBOX_MAX), after },
      'inbox_result',
    )) as Extract<ServerMessage, { t: 'inbox_result' }>
    if (res.error) throw new Error(res.error)
    const text = formatInbox(res.messages, after)
    const last = res.messages.at(-1)
    const body =
      res.truncated && last
        ? `${text}\n(truncated: more messages follow; continue with after: ${last.msgId})`
        : text
    // A seat that reads by pull never gets a channel push, so the advisory rides this reply (CC-922).
    return withHint(body, ctx.contextHint?.())
  },
})
