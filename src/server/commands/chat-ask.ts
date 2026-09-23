import { z } from 'zod'
import { requiredString } from '../../args.js'
import { defineTool } from '../command.js'
import { toHuman } from './to-human.js'

export const chatAsk = defineTool({
  name: 'chat_ask',
  description:
    'Ask the human a question and stop waiting on it. Use ONLY when you genuinely cannot proceed and no ' +
    'reasonable default exists — prefer deciding and saying what you assumed. The answer arrives later as a ' +
    'channel message, so continue with other work meanwhile. You may have at most 3 unanswered questions.',
  args: z.object({
    text: requiredString('text').describe('The question, with enough context to answer it cold'),
  }),
  result: z.string(),
  async run({ text }, ctx) {
    if (!ctx.registeredName) return 'Call chat_register first.'
    return toHuman(ctx.broker, 'ask', text)
  },
})
