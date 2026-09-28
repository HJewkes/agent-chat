import { z } from 'zod'
import { requiredString } from '../../args.js'
import { QUEUE_ITEM_KINDS } from '../../protocol.js'
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
    kind: z.enum(QUEUE_ITEM_KINDS).optional().describe('What sort of item this is, for grouping'),
    task: z.string().optional().describe('The task id you were working on'),
    options: z.array(z.string()).optional().describe('The choices, if the answer is one of a few'),
    recommended: z.string().optional().describe('The answer you would pick; shown first'),
    onNoAnswer: z.string().optional().describe('What you will do if nobody answers, or "parked"'),
  }),
  result: z.string(),
  async run({ text, ...shape }, ctx) {
    if (!ctx.registeredName) return 'Call chat_register first.'
    return toHuman(ctx.broker, 'ask', text, shape)
  },
})
