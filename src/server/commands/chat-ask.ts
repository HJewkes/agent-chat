import { z } from 'zod'
import { requiredString } from '../../args.js'
import { ASK_BLOCKING, ASK_DOORS, QUEUE_ITEM_KINDS, type ItemShape } from '../../protocol.js'
import { defineTool } from '../command.js'
import { toHuman } from './to-human.js'

const AskOption = z.union([z.string(), z.object({ label: z.string(), description: z.string().optional() })])

/** Labels stay a plain list, so readers from before descriptions see what they always saw. */
function splitOptions(options: Array<z.infer<typeof AskOption>> | undefined): ItemShape {
  if (!options) return {}
  const labels = options.map(o => (typeof o === 'string' ? o : o.label))
  const descriptions = options.map(o => (typeof o === 'string' ? '' : (o.description ?? '')))
  return {
    options: labels,
    ...(descriptions.some(d => d !== '') ? { optionDescriptions: descriptions } : {}),
  }
}

export const chatAsk = defineTool({
  name: 'chat_ask',
  description:
    'Ask the human a question and stop waiting on it. Use ONLY when you genuinely cannot proceed and no ' +
    'reasonable default exists — prefer deciding and saying what you assumed. The answer arrives later as a ' +
    'channel message, so continue with other work meanwhile. You may have at most 3 unanswered questions. ' +
    'Set door: an ask without one is treated as one-way.',
  args: z.object({
    text: requiredString('text').describe('The question, with enough context to answer it cold'),
    kind: z.enum(QUEUE_ITEM_KINDS).optional().describe('What sort of item this is, for grouping'),
    task: z.string().optional().describe('The task id you were working on'),
    header: z.string().optional().describe('A one-line title for the queue, at most 80 characters'),
    options: z
      .array(AskOption)
      .optional()
      .describe('The choices, if the answer is one of a few: a label, or {label, description}'),
    recommended: z.string().optional().describe('The answer you would pick; shown first'),
    default: z.string().optional().describe('The option taken if nobody answers; must be one of the labels'),
    door: z
      .enum(ASK_DOORS)
      .optional()
      .describe('two-way if the answer is cheap to undo; absent is treated as one-way'),
    category: z
      .string()
      .optional()
      .describe('Decision category, e.g. tech_design, scope_priority, merge_gate'),
    initiative: z.string().optional().describe('The initiative slug the question belongs to'),
    blocking: z
      .enum(ASK_BLOCKING)
      .optional()
      .describe('continue if you carry on meanwhile, parked if you stopped'),
    reversible: z.string().optional().describe('One line on how to undo the answer'),
    onNoAnswer: z.string().optional().describe('What you will do if nobody answers, or "parked"'),
  }),
  result: z.string(),
  async run({ text, options, ...shape }, ctx) {
    if (!ctx.registeredName) return 'Call chat_register first.'
    return toHuman(ctx.broker, 'ask', text, { ...shape, ...splitOptions(options) })
  },
})
