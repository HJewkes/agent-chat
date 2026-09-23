import { z } from 'zod'
import { requiredString } from '../../args.js'
import { defineTool } from '../command.js'
import { toHuman } from './to-human.js'

export const chatNotify = defineTool({
  name: 'chat_notify',
  description:
    'Leave the human a status notice that needs no answer, e.g. finishing a long task or hitting something ' +
    'they should know about. It waits in their queue; it does not interrupt them.',
  args: z.object({ text: requiredString('text').describe('One line worth their attention') }),
  result: z.string(),
  async run({ text }, ctx) {
    if (!ctx.registeredName) return 'Call chat_register first.'
    return toHuman(ctx.broker, 'notify', text)
  },
})
