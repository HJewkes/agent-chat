import { z } from 'zod'
import { EXIT } from '@titan-design/registry'
import { requiredString } from '../../args.js'
import { burndownSender, BURNDOWN_SENDER } from '../burndown-broker.js'
import { defineVerb, Report, type VerbContext } from '../command.js'
import { PortRefusal, runPort } from '../port.js'
import { readStdin } from './permission-hook.js'

/** `data` of a `port send` envelope: the broker took the message. */
export const SendPortOutput = z.object({ sent: z.literal(true) })
export type SendPortOutput = z.infer<typeof SendPortOutput>

class UsageError extends Error {
  readonly code = EXIT.USAGE
}

const Args = z.object({
  as: requiredString('--as <sender>'),
  to: z.string().optional(),
  notify: z.boolean().optional(),
  task: z.string().optional(),
})
type Args = z.infer<typeof Args>

function checkUsage({ as, to, notify, task }: Args): void {
  if (as !== BURNDOWN_SENDER) throw new UsageError(`--as accepts only ${BURNDOWN_SENDER}, not ${as}`)
  if (notify === true && to !== undefined)
    throw new UsageError('--notify files a notice and takes no recipient')
  if (notify !== true && to === undefined) throw new UsageError('give a recipient, or --notify')
  if (notify !== true && task !== undefined) throw new UsageError('--task goes with --notify')
}

const REGISTER_REFUSED = `register as ${BURNDOWN_SENDER}`

/** A refusal reason that is really a silent broker keeps the CC-640 shape: the write may have landed. */
function refusal(reason: string): Error {
  if (reason.startsWith('broker did not answer')) return new Error(reason)
  if (reason.startsWith(REGISTER_REFUSED)) return new PortRefusal('register_refused', reason)
  return new PortRefusal('send_refused', reason)
}

/** Sends the stdin text as `burndown`: registers on the port's connection, then sends or notifies. */
export async function portSend(args: Args, ctx: VerbContext, readText = readStdin): Promise<Report> {
  checkUsage(args)
  const text = await readText()
  if (text.trim() === '') throw new UsageError('the message is empty: pass it on stdin')
  return runPort(ctx, async (broker): Promise<SendPortOutput> => {
    const sender = await burndownSender(async () => broker)()
    const res =
      args.notify === true ? await sender.notify(text, args.task) : await sender.send(args.to!, text)
    if (!res.ok) throw refusal(res.reason ?? 'refused')
    return { sent: true }
  })
}

export const portSendVerb = defineVerb({
  name: 'port.send',
  description: 'send or notify as burndown, text on stdin, as one JSON envelope line; never starts a broker',
  args: Args,
  result: Report,
  cli: {
    positional: ['to'],
    options: {
      as: { long: '--as <sender>', description: `the sender label; only ${BURNDOWN_SENDER}` },
      notify: {
        long: '--notify',
        description: 'file a notice on the human queue instead of messaging an agent',
      },
      task: { long: '--task <id>', description: 'the task a notice is about (with --notify)' },
    },
  },
  run: (args, ctx) => portSend(args, ctx),
})
