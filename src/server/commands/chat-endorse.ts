import { z } from 'zod'
import { requiredString } from '../../args.js'
import type { ServerMessage } from '../../protocol.js'
import { defineTool } from '../command.js'

export const chatEndorse = defineTool({
  name: 'chat_endorse',
  description:
    'Put a message to your human for approval, and on approval have the broker deliver it to a peer ' +
    'marked as carrying that human’s authority. This does NOT send: your human is shown the exact ' +
    'bytes below and either approves or declines, and the broker delivers the stored text — you do ' +
    'not get to send it yourself afterwards. Use it to relay a decision your human has actually made, ' +
    'when a peer needs it AS a decision; an ordinary chat_send saying "my human wants X" is a peer ' +
    'reporting a claim, and a peer is right to want more than that before acting. Do NOT use it to ' +
    'give your own view extra weight — the message arrives under YOUR name with your human’s ' +
    'authority behind it, so composing something they did not mean and getting it waved through is ' +
    'laundering your intent into an instruction to someone else. Write what they decided, in their ' +
    'terms, and no more. One approval covers this one message and nothing else. The recipient is ' +
    'still entitled to weigh it. You may have 2 waiting at a time.',
  args: z.object({
    to: requiredString('to').describe('Registered name of the peer who should receive it'),
    text: requiredString('text').describe(
      'The exact message to deliver. Your human reads this verbatim; whatever you write here is ' +
        'what arrives, so make it stand on its own — the recipient sees no other context.',
    ),
  }),
  result: z.string(),
  async run({ to, text }, ctx) {
    if (!ctx.registeredName)
      return 'Call chat_register before composing an endorsement, so the recipient knows who you are.'
    const res = (await ctx.broker.request({ t: 'endorse', to, text }, 'send_result')) as Extract<
      ServerMessage,
      { t: 'send_result' }
    >
    if (!res.ok) return `Not queued: ${res.reason}`
    return (
      `Waiting on your human (msg_id ${res.msgId}). NOTHING has been sent to "${to}" and nothing will ` +
      'be unless they approve it, at which point the broker delivers exactly the text above. Carry ' +
      'on with other work; do not send it yourself in the meantime.'
    )
  },
})
