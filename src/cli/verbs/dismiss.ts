import { z } from 'zod'
import type { ServerMessage } from '../../protocol.js'
import { describeDismiss } from '../human.js'
import { defineVerb, Report } from '../command.js'

export const dismissVerb = defineVerb({
  name: 'human.dismiss',
  description: 'close an item without answering, or decline an endorsement',
  args: z.object({ id: z.string() }),
  result: Report,
  cli: { positional: ['id'] },
  async run({ id }, ctx) {
    const res = (await ctx.withBroker(b =>
      b.request({ t: 'dismiss', msgId: id }, 'answer_result'),
    )) as Extract<ServerMessage, { t: 'answer_result' }>
    return describeDismiss(id, res)
  },
})
