import { z } from 'zod'
import { requiredString } from '../../args.js'
import { SURFACE_NAMES, type ServerMessage } from '../../protocol.js'
import { describeResume } from '../../agents/resume-session.js'
import { defineVerb, Report } from '../command.js'

export const agentResume = defineVerb({
  name: 'agent.resume',
  description: 'bring a stopped agent back on its own conversation (headless by default)',
  args: z.object({
    name: requiredString('name'),
    message: z.string().optional(),
    surface: z.enum(SURFACE_NAMES).optional(),
  }),
  result: Report,
  cli: {
    positional: ['name'],
    options: {
      message: { long: '--message', description: 'the turn it resumes on' },
      surface: { long: '--surface', description: `where it comes back: ${SURFACE_NAMES.join(', ')}` },
    },
  },
  async run({ name, message, surface }, ctx) {
    const res = (await ctx.withBroker(b =>
      b.request(
        {
          t: 'resume',
          name,
          ...(message === undefined ? {} : { message }),
          ...(surface === undefined ? {} : { surface }),
        },
        'spawn_result',
      ),
    )) as Extract<ServerMessage, { t: 'spawn_result' }>
    return describeResume(name, res)
  },
})
