import { z } from 'zod'
import { requiredString } from '../../args.js'
import { QUEUE_ITEM_KINDS } from '../../protocol.js'
import { defineTool } from '../command.js'
import { toHuman } from './to-human.js'

export const chatNotify = defineTool({
  name: 'chat_notify',
  description:
    'Leave the human a status notice that needs no answer, e.g. finishing a long task or hitting something ' +
    'they should know about. It waits in their queue; it does not interrupt them.',
  args: z.object({
    text: requiredString('text').describe('One line worth their attention'),
    kind: z.enum(QUEUE_ITEM_KINDS).optional().describe('What sort of item this is, for grouping'),
    task: z.string().optional().describe('The task id it concerns'),
  }),
  result: z.string(),
  async run({ text, ...shape }, ctx) {
    if (!ctx.registeredName) return 'Call chat_register first.'
    return toHuman(ctx.broker, 'notify', text, shape)
  },
})
