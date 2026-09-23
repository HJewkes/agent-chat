import { z } from 'zod'
import { present } from '../../args.js'
import { SESSION_STATUSES, type ServerMessage } from '../../protocol.js'
import { declaredField, declaredLabels, defineTool } from '../command.js'

function quietLine(dnd: boolean | undefined): string {
  if (dnd === undefined) return ''
  return dnd ? ' Holding pushes from other sessions; they collect in your inbox.' : ' Taking pushes again.'
}

export const chatStatus = defineTool({
  name: 'chat_status',
  description:
    'Update what this session is doing and whether it is free to take work. Set dnd to hold ' +
    'incoming pushes when you need a long stretch of focus: nothing is lost, messages collect ' +
    'in your inbox and chat_inbox returns them whenever you next look. Your user can still ' +
    "reach you; other sessions cannot. Set dnd BEFORE a long stretch of focused work you don't " +
    "want interrupted — don't wait until a peer message already derailed you.",
  args: z.object({
    status: z.enum(SESSION_STATUSES, { error: `status must be one of: ${SESSION_STATUSES.join(', ')}` }),
    working_on: z.string().describe('Optional new description of current work').optional(),
    dnd: z
      .boolean()
      .describe('Hold pushes from other sessions until you clear it. Independent of status.')
      .optional(),
    declared: declaredField(
      'Replace the self-reported labels from chat_register, e.g. when you move to a new task. ' +
        'This REPLACES the whole set rather than merging, so send every label you still want; ' +
        'an empty object clears them. Omit it to leave them as they are.',
    ),
  }),
  result: z.string(),
  async run({ status, dnd, ...input }, { broker }) {
    const workingOn = present(input.working_on)
    const declared = declaredLabels(input.declared)
    const res = (await broker.request(
      {
        t: 'status',
        status,
        ...(workingOn === undefined ? {} : { workingOn }),
        ...(dnd === undefined ? {} : { dnd }),
        ...(declared === undefined ? {} : { declared }),
      },
      'status_result',
    )) as Extract<ServerMessage, { t: 'status_result' }>
    if (!res.ok) return 'Call chat_register first.'
    return `Status set to "${status}".${quietLine(dnd)}`
  },
})
