import { z } from 'zod'
import { requiredString } from '../../args.js'
import { DECISION_BASES, type ServerMessage } from '../../protocol.js'
import { defineTool } from '../command.js'

export const chatDecide = defineTool({
  name: 'chat_decide',
  description:
    'Decider profile only: answer one open human-queue question on the human’s behalf, citing the ' +
    'precedent it rests on. The broker refuses unless you are the configured decider, the question is ' +
    'still open and undecided, the class is decidable, and neither question nor answer touches the ' +
    'unlock table (merges, publishing, deploys, money, external accounts, deletions and the rest). A ' +
    'refused question stays queued for the human; do not rephrase it to get past the check. The asker ' +
    'receives your answer marked provenance="decided" and the human sees it for audit and may overrule it.',
  args: z.object({
    msg_id: requiredString('msg_id').describe('The msg_id of the open question, from agent-chat inbox'),
    text: requiredString('text').describe('The answer the asker receives, standing on its own'),
    precedent: requiredString('precedent').describe(
      'The citation, verbatim from precedent search or a policy file with its heading',
    ),
    class: requiredString('class').describe('The question class, in precedent search’s vocabulary'),
    basis: z.enum(DECISION_BASES).describe('policy, precedent (two or more agreeing answers), or context'),
    reversible: requiredString('reversible').describe('How to undo this decision if the human overrules it'),
  }),
  result: z.string(),
  async run(args, ctx) {
    if (!ctx.registeredName) return 'Call chat_register first.'
    const { msg_id: msgId, text, precedent, basis, reversible } = args
    const res = (await ctx.broker.request(
      { t: 'decided', msgId, text, precedent, class: args.class, basis, reversible },
      'decided_result',
    )) as Extract<ServerMessage, { t: 'decided_result' }>
    if (!res.ok)
      return `Not decided (${res.code ?? 'refused'}): ${res.reason ?? ''} It stays queued for the human.`
    return `Decided ${msgId}.${res.reason ? ` ${res.reason}` : ''}`
  },
})
