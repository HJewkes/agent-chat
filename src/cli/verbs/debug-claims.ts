import { z } from 'zod'
import type { ServerMessage } from '../../protocol.js'
import { describeClaims } from '../debug.js'
import { defineVerb, Report } from '../command.js'

export const debugClaimsVerb = defineVerb({
  name: 'debug.claims',
  description: 'who holds which worktrees and paths',
  args: z.object({}),
  result: Report,
  async run(_args, ctx) {
    const res = (await ctx.withBroker(b => b.request({ t: 'list' }, 'list_result'))) as Extract<
      ServerMessage,
      { t: 'list_result' }
    >
    return describeClaims(res)
  },
})
