import { z } from 'zod'
import type { ServerMessage } from '../../protocol.js'
import { describeInbox } from '../human.js'
import { defineVerb, Report } from '../command.js'

export const inboxVerb = defineVerb({
  name: 'human.inbox',
  description: 'what your agents need from you',
  args: z.object({}),
  result: Report,
  async run(_args, ctx) {
    const res = (await ctx.withBroker(b => b.request({ t: 'queue' }, 'queue_result'))) as Extract<
      ServerMessage,
      { t: 'queue_result' }
    >
    return describeInbox(res)
  },
})
