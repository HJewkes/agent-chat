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
    'Optional: header (<=80 chars); options as labels or {label, description}; default (a label); door ' +
    '(absent = one-way); category; initiative; blocking; reversible (how to undo); onNoAnswer.',
  args: z.object({
    text: requiredString('text').describe('The question, with enough context to answer it cold'),
    kind: z.enum(QUEUE_ITEM_KINDS).optional(),
    task: z.string().optional().describe('The task id you were working on'),
    header: z.string().optional(),
    options: z.array(AskOption).optional(),
    recommended: z.string().optional().describe('The answer you would pick; shown first'),
    default: z.string().optional(),
    door: z.enum(ASK_DOORS).optional(),
    category: z.string().optional(),
    initiative: z.string().optional(),
    blocking: z.enum(ASK_BLOCKING).optional(),
    reversible: z.string().optional(),
    onNoAnswer: z.string().optional(),
  }),
  result: z.string(),
  async run({ text, options, ...shape }, ctx) {
    if (!ctx.registeredName) return 'Call chat_register first.'
    return toHuman(ctx.broker, 'ask', text, { ...shape, ...splitOptions(options) })
  },
})
