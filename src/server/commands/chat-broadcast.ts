import { z } from 'zod'
import { requiredString } from '../../args.js'
import type { ServerMessage } from '../../protocol.js'
import { defineTool } from '../command.js'

export const chatBroadcast = defineTool({
  name: 'chat_broadcast',
  description:
    'Send a message to every registered session except this one. Use sparingly: the cost is ' +
    'the message times the number of sessions, and each one is a derailed turn. The bus is ' +
    'machine-wide, so recipients include sessions on unrelated initiatives with no stake in ' +
    'your work. Past a budget a broadcast is held in recipients’ inboxes instead of being ' +
    'pushed, so prefer chat_send to the sessions that actually need it.',
  args: z.object({ text: requiredString('text').describe('Message body') }),
  result: z.string(),
  async run({ text }, ctx) {
    if (!ctx.registeredName) return 'Call chat_register before broadcasting.'
    const res = (await ctx.broker.request({ t: 'broadcast', text }, 'send_result')) as Extract<
      ServerMessage,
      { t: 'send_result' }
    >
    if (!res.ok) return `Not delivered: ${res.reason}`
    if (res.recipients.length === 0) return 'No other sessions are registered, so nobody received it.'
    if (res.held) return `Held for ${res.recipients.join(', ')}: ${res.reason}`
    return `Broadcast to ${res.recipients.join(', ')} (msg_id ${res.msgId}).`
  },
})
