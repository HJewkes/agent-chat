import { z } from 'zod'
import type { ServerMessage } from '../../protocol.js'
import { describeHistory } from '../debug.js'
import { defineVerb, Report } from '../command.js'

export const debugHistoryVerb = defineVerb({
  name: 'debug.history',
  description: 'recent events from the log (default 30)',
  args: z.object({ n: z.coerce.number().optional() }),
  result: Report,
  cli: { positional: ['n'] },
  async run({ n }, ctx) {
    const res = (await ctx.withBroker(b =>
      b.request({ t: 'history', limit: n ?? 30 }, 'history_result'),
    )) as Extract<ServerMessage, { t: 'history_result' }>
    return describeHistory(res)
  },
})
