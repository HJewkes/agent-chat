import { z } from 'zod'
import type { ServerMessage } from '../../protocol.js'
import { describeEndorse } from '../human.js'
import { defineVerb, Report } from '../command.js'

/**
 * A CLI verb and nothing else: the broker refuses this frame from any
 * registered connection, so the only caller that can reach it is a person at a
 * 0600 socket. The command restates the exact text and recipient (CC-418), so
 * what the person approving it read is what the broker delivers, or nothing.
 */
export const endorseVerb = defineVerb({
  name: 'human.endorse',
  description: 'approve a composed message; delivers it with your authority',
  args: z.object({ id: z.string(), to: z.string().optional(), text: z.string().optional() }),
  result: Report,
  cli: {
    positional: ['id'],
    options: {
      to: { long: '--to', description: 'the recipient the request names, exactly' },
      text: { long: '--text', description: 'the request text, byte for byte' },
    },
  },
  async run({ id, to, text }, ctx) {
    if (to === undefined || text === undefined)
      return {
        ok: false,
        lines: [],
        errors: [`endorse needs --to and --text restating request ${id} exactly`],
      }
    const res = (await ctx.withBroker(b =>
      b.request({ t: 'endorse_approve', msgId: id, text, to }, 'answer_result'),
    )) as Extract<ServerMessage, { t: 'answer_result' }>
    return describeEndorse(id, res)
  },
})
