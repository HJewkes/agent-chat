import { z } from 'zod'
import { requiredString } from '../../args.js'
import {
  ASK_BLOCKING,
  ASK_DOORS,
  QUEUE_ITEM_KINDS,
  type ClientMessage,
  type ServerMessage,
} from '../../protocol.js'
import type { BrokerClient } from '../../client/broker-client.js'
import { BROKER_UNAVAILABLE_EXIT, BrokerUnavailableError } from '../client.js'
import { defineVerb, Report, type VerbContext } from '../command.js'
import { readStdin } from './permission-hook.js'

/** `ask` and `answers` exit 2 on a usage error, so a caller can tell it from a refusal (1). */
export const USAGE_EXIT = 2

class UsageError extends Error {
  readonly code = USAGE_EXIT
}

/** A down or too-old broker: the caller should try again later, not give up on the ask. */
class BrokerTooOldError extends Error {
  readonly code = BROKER_UNAVAILABLE_EXIT
}

type ReplyType = Parameters<BrokerClient['request']>[1]

/**
 * One request for a frame added in CC-169. A broker started before it drops the
 * frame without a reply (R8), which surfaces here as the client's reply timeout.
 */
export async function serviceRequest(
  ctx: VerbContext,
  message: ClientMessage,
  replyType: ReplyType,
): Promise<ServerMessage> {
  try {
    return await ctx.withBroker(b => b.request(message, replyType))
  } catch (err) {
    if (err instanceof BrokerUnavailableError) throw err
    const reason = err instanceof Error ? err.message : String(err)
    if (reason.startsWith('broker did not answer'))
      throw new BrokerTooOldError(`broker too old: it did not answer ${message.t}; it needs a restart`)
    if (reason.startsWith('could not reach or start')) throw new BrokerTooOldError(reason)
    throw err
  }
}

async function questionText(words: string[] | undefined, fromStdin: boolean | undefined) {
  if (fromStdin && words?.length) throw new UsageError('give the question as words or --text-stdin, not both')
  const text = fromStdin ? await readStdin() : (words ?? []).join(' ')
  if (text.trim() === '') throw new UsageError('the question is empty: pass words or --text-stdin')
  return text
}

/** `--option-description` pairs with `--option` by position; a missing one is `""`. */
function optionShape(options: string[] | undefined, descriptions: string[] | undefined) {
  if ((descriptions?.length ?? 0) > (options?.length ?? 0))
    throw new UsageError('each --option-description needs a matching --option before it')
  if (!options) return {}
  if (!descriptions) return { options }
  return { options, optionDescriptions: options.map((_, i) => descriptions[i] ?? '') }
}

const Args = z.object({
  as: requiredString('--as <label>'),
  text: z.array(z.string()).optional(),
  textStdin: z.boolean().optional(),
  kind: z.enum(QUEUE_ITEM_KINDS).optional(),
  task: z.string().optional(),
  option: z.array(z.string()).optional(),
  optionDescription: z.array(z.string()).optional(),
  recommended: z.string().optional(),
  onNoAnswer: z.string().optional(),
  header: z.string().optional(),
  door: z.enum(ASK_DOORS).optional(),
  default: z.string().optional(),
  category: z.string().optional(),
  initiative: z.string().optional(),
  blocking: z.enum(ASK_BLOCKING).optional(),
  reversible: z.string().optional(),
  json: z.boolean().optional(),
})

/**
 * For a process that is not a Claude session, such as a factory gate notifier
 * (CC-169). It files the question and exits; `answers` reads what happened later.
 * Stdout is the msg_id alone, so `id=$(agent-chat ask ...)` works.
 */
export const askVerb = defineVerb({
  name: 'service.ask',
  description: 'put a question to the human under a service label and print its msg_id',
  args: Args,
  result: Report,
  cli: {
    positional: ['text'],
    options: {
      as: { long: '--as', valueName: 'label', description: 'the label answers are read back under' },
      textStdin: { long: '--text-stdin', description: 'read the question from stdin, not argv' },
      kind: { long: '--kind', valueName: 'kind', description: `one of ${QUEUE_ITEM_KINDS.join(', ')}` },
      task: { long: '--task', valueName: 'id', description: 'the task or gate the question is about' },
      header: {
        long: '--header',
        valueName: 'text',
        description: 'a one-line title for the queue, at most 80 chars',
      },
      option: { long: '--option', description: 'an answer to offer (repeatable)' },
      optionDescription: {
        long: '--option-description',
        description: 'describes the --option at the same position (repeatable)',
      },
      recommended: { long: '--recommended', valueName: 'option', description: 'the option you recommend' },
      default: { long: '--default', valueName: 'option', description: 'the option taken if nobody answers' },
      door: {
        long: '--door',
        valueName: 'door',
        description: `${ASK_DOORS.join(' or ')}; absent is treated as one-way`,
      },
      category: { long: '--category', valueName: 'name', description: 'decision category, e.g. tech_design' },
      initiative: {
        long: '--initiative',
        valueName: 'slug',
        description: 'the initiative the question belongs to',
      },
      blocking: {
        long: '--blocking',
        valueName: 'mode',
        description: `${ASK_BLOCKING.join(' or ')}: is the asker waiting`,
      },
      reversible: {
        long: '--reversible',
        valueName: 'text',
        description: 'one line on how to undo the answer',
      },
      onNoAnswer: {
        long: '--on-no-answer',
        valueName: 'text',
        description: 'what happens if nobody answers',
      },
      json: { long: '--json', description: 'print {"msgId": ...} instead of the bare id' },
    },
  },
  async run({ as, text: words, textStdin, json, option, optionDescription, ...shape }, ctx) {
    const options = optionShape(option, optionDescription)
    const text = await questionText(words, textStdin)
    const frame = { t: 'service_ask', as, text, ...shape, ...options } as const
    const res = (await serviceRequest(ctx, frame, 'service_ask_result')) as Extract<
      ServerMessage,
      { t: 'service_ask_result' }
    >
    if (!res.ok || !res.msgId) return { ok: false, lines: [], errors: [res.reason ?? 'refused'] }
    return { ok: true, lines: [json ? JSON.stringify({ msgId: res.msgId }) : res.msgId] }
  },
})
