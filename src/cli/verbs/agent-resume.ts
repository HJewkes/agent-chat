import { z } from 'zod'
import { requiredString } from '../../args.js'
import { SURFACE_NAMES, type ServerMessage } from '../../protocol.js'
import { describeResume } from '../../agents/resume-session.js'
import { defineVerb, Report } from '../command.js'

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** The wake text, from `--message` or all of stdin; both, or an empty stdin, is an error. */
async function resumeMessage(message: string | undefined, fromStdin: boolean | undefined) {
  if (!fromStdin) return message
  if (message !== undefined)
    throw new Error('--message-stdin reads the message from stdin; do not also pass --message')
  const text = await readStdin()
  if (text.trim() === '') throw new Error('--message-stdin got an empty message on stdin')
  return text
}

export const agentResume = defineVerb({
  name: 'agent.resume',
  description: 'bring a stopped agent back on its own conversation (headless by default)',
  args: z.object({
    name: requiredString('name'),
    message: z.string().optional(),
    messageStdin: z.boolean().optional(),
    surface: z.enum(SURFACE_NAMES).optional(),
  }),
  result: Report,
  cli: {
    positional: ['name'],
    options: {
      message: { long: '--message', description: 'the turn it resumes on' },
      messageStdin: { long: '--message-stdin', description: 'read the turn from stdin, not argv' },
      surface: { long: '--surface', description: `where it comes back: ${SURFACE_NAMES.join(', ')}` },
    },
  },
  async run({ name, message: messageArg, messageStdin, surface }, ctx) {
    const message = await resumeMessage(messageArg, messageStdin)
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
