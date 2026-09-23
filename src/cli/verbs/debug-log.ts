import { z } from 'zod'
import type { ServerMessage } from '../../protocol.js'
import { describeRoutingLog } from '../debug.js'
import { defineVerb, Report } from '../command.js'

export const debugLogVerb = defineVerb({
  name: 'debug.log',
  description: 'recent routing decisions',
  args: z.object({ n: z.coerce.number().optional() }),
  result: Report,
  cli: { positional: ['n'] },
  async run({ n }, ctx) {
    const res = (await ctx.withBroker(b =>
      b.request({ t: 'history', limit: n ?? 20 }, 'history_result'),
    )) as Extract<ServerMessage, { t: 'history_result' }>
    return describeRoutingLog(res)
  },
})
