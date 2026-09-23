import { z } from 'zod'
import { requiredString } from '../../args.js'
import { SURFACE_NAMES, type ServerMessage } from '../../protocol.js'
import { describeResume } from '../../agents/resume-session.js'
import { defineTool } from '../command.js'

export const agentResume = defineTool({
  name: 'agent_resume',
  description:
    'Bring back a finished, detached or failed agent WITH its conversation, under the same name and ' +
    'identity, headless by default. Use it for a follow-up to an agent that already knows the work. ' +
    'It is refused for a live agent (message it instead) and when its transcript is gone, and the ' +
    'reply always says whether the transcript was found. A RETIRED agent gave up its name: agent_list ' +
    'shows its session id, and agent_spawn with resume_session brings it back as a new agent.',
  args: z.object({
    name: requiredString('name').describe('The agent to resume, as shown by agent_list.'),
    message: z
      .string()
      .optional()
      .describe(
        'The turn it resumes on: what to do next. Omit for a generic "check your inbox and continue".',
      ),
    surface: z
      .enum(SURFACE_NAMES)
      .optional()
      .describe(
        'Where it comes back. Defaults to headless; a visible surface opens a pane and drops message.',
      ),
  }),
  result: z.string(),
  async run({ name, message, surface }, ctx) {
    const res = (await ctx.broker.request(
      {
        t: 'resume',
        name,
        ...(message === undefined ? {} : { message }),
        ...(surface === undefined ? {} : { surface }),
      },
      'spawn_result',
    )) as Extract<ServerMessage, { t: 'spawn_result' }>
    return describeResume(name, res).lines.join('\n')
  },
})
