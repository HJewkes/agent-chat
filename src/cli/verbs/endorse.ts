import { z } from 'zod'
import type { ServerMessage } from '../../protocol.js'
import { describeEndorse } from '../human.js'
import { defineVerb, Report } from '../command.js'

/**
 * A CLI verb and nothing else: the broker refuses this frame from any
 * registered connection, so the only caller that can reach it is a person at a
 * 0600 socket. No text argument — the bytes are the ones already stored and
 * already shown by `inbox`, which is what makes the delivered message
 * necessarily the one that was read.
 */
export const endorseVerb = defineVerb({
  name: 'human.endorse',
  description: 'approve a composed message; delivers it with your authority',
  args: z.object({ id: z.string() }),
  result: Report,
  cli: { positional: ['id'] },
  async run({ id }, ctx) {
    const res = (await ctx.withBroker(b =>
      b.request({ t: 'endorse_approve', msgId: id }, 'answer_result'),
    )) as Extract<ServerMessage, { t: 'answer_result' }>
    return describeEndorse(id, res)
  },
})
