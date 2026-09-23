import { z } from 'zod'
import type { ServerMessage } from '../../protocol.js'
import { describePs } from '../debug.js'
import { defineVerb, Report } from '../command.js'

export const debugPsVerb = defineVerb({
  name: 'debug.ps',
  description: 'list registered sessions',
  args: z.object({}),
  result: Report,
  async run(_args, ctx) {
    const res = (await ctx.withBroker(b => b.request({ t: 'list' }, 'list_result'))) as Extract<
      ServerMessage,
      { t: 'list_result' }
    >
    return describePs(res)
  },
})
