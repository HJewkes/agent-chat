import { z } from 'zod'
import { requiredString } from '../../args.js'
import { SURFACE_NAMES, type ServerMessage } from '../../protocol.js'
import { describeResume } from '../../agents/resume-session.js'
import { defineTool } from '../command.js'

export const agentResume = defineTool({
  name: 'agent_resume',
  description:
    'Bring back a stopped (finished, detached, failed) agent WITH its conversation, same identity, ' +
    'headless by default, to follow up. Refused for a live agent (message it instead) or a ' +
    'missing transcript; the reply says if the transcript was found. A RETIRED agent gave up ' +
    'its name: agent_spawn with resume_session (see agent_list) brings it back as new.',
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
    host: z
      .string()
      .optional()
      .describe('Machine (alias or hostname) with its transcript; resumes there, not here.'),
  }),
  result: z.string(),
  async run({ name, message, surface, host }, ctx) {
    const res = (await ctx.broker.request(
      {
        t: 'resume',
        name,
        ...(message === undefined ? {} : { message }),
        ...(surface === undefined ? {} : { surface }),
        ...(host === undefined || host.trim() === '' ? {} : { host }),
      },
      'spawn_result',
    )) as Extract<ServerMessage, { t: 'spawn_result' }>
    return describeResume(name, res).lines.join('\n')
  },
})
