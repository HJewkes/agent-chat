import { z } from 'zod'
import { requiredString } from '../../args.js'
import { QUEUE_ITEM_KINDS, type ClientMessage, type ServerMessage } from '../../protocol.js'
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

const Args = z.object({
  as: requiredString('--as <label>'),
  text: z.array(z.string()).optional(),
  textStdin: z.boolean().optional(),
  kind: z.enum(QUEUE_ITEM_KINDS).optional(),
  task: z.string().optional(),
  option: z.array(z.string()).optional(),
  recommended: z.string().optional(),
  onNoAnswer: z.string().optional(),
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
      as: { long: '--as <label>', description: 'the label answers are read back under' },
      textStdin: { long: '--text-stdin', description: 'read the question from stdin, not argv' },
      kind: { long: '--kind <kind>', description: `one of ${QUEUE_ITEM_KINDS.join(', ')}` },
      task: { long: '--task <id>', description: 'the task or gate the question is about' },
      option: { long: '--option', description: 'an answer to offer (repeatable)' },
      recommended: { long: '--recommended <option>', description: 'the option you recommend' },
      onNoAnswer: { long: '--on-no-answer <text>', description: 'what happens if nobody answers' },
      json: { long: '--json', description: 'print {"msgId": ...} instead of the bare id' },
    },
  },
  async run({ as, text: words, textStdin, json, option, ...shape }, ctx) {
    const text = await questionText(words, textStdin)
    const frame = { t: 'service_ask', as, text, ...shape, ...(option ? { options: option } : {}) } as const
    const res = (await serviceRequest(ctx, frame, 'service_ask_result')) as Extract<
      ServerMessage,
      { t: 'service_ask_result' }
    >
    if (!res.ok || !res.msgId) return { ok: false, lines: [], errors: [res.reason ?? 'refused'] }
    return { ok: true, lines: [json ? JSON.stringify({ msgId: res.msgId }) : res.msgId] }
  },
})
