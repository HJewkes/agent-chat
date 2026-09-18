import { z } from 'zod'
import { MAX_MULTICAST_RECIPIENTS, tagProblem } from '../../protocol.js'
import type { RecipientResult, ServerMessage } from '../../protocol.js'
import { defineTool, nonBlank, requiredString } from '../command.js'

const RECIPIENTS = 'to must be a non-empty session name, or a list of them'

// Bounds as metadata keep the published schema as it was; an oversized list gets the refusal in run.
const recipientList = z
  .array(nonBlank(RECIPIENTS), { error: RECIPIENTS })
  .refine(names => names.length > 0, RECIPIENTS)
  .meta({ minItems: 1, maxItems: MAX_MULTICAST_RECIPIENTS })

const args = z.object({
  to_tag: z
    .string()
    .describe(
      'Send to every session carrying this tag instead of naming recipients, e.g. "owner:src". ' +
        'Mutually exclusive with to. chat_list shows who carries what. A tag is a label, NOT a ' +
        'permission: whoever carries it chose to, or a peer said so, and neither makes them ' +
        'responsible for the work you are sending.',
    )
    .optional(),
  // Optional here because exactly one of to and to_tag is required, which a flat `required` cannot say.
  to: z
    .union([requiredString('to'), recipientList], { error: RECIPIENTS })
    .describe(
      'Registered name of the recipient session, or a list of up to ' +
        `${MAX_MULTICAST_RECIPIENTS} names to tell the same thing once.`,
    )
    .optional(),
  text: requiredString('text').describe('Message body'),
  in_reply_to: z.string().describe('msg_id of the message being answered, if any').optional(),
})

type SendArgs = z.infer<typeof args>
type SendResult = Extract<ServerMessage, { t: 'send_result' }>
interface Target {
  to?: string | string[]
  toTag?: string
}

/** Blank counts as absent, as it always has for chat_send's optional strings. */
const present = (value: string | undefined): string | undefined => (value?.trim() ? value : undefined)

/**
 * Who a chat_send is aimed at: names, or a tag, and never both.
 *
 * `to_tag` is a SEPARATE parameter rather than a spelling inside `to`, and that
 * is the point: a session may legitimately be named `owner:src`, and a call that
 * had to guess which one was meant would sometimes guess wrong silently.
 */
function sendTarget({ to, to_tag }: SendArgs): Target {
  const toTag = present(to_tag)
  if (toTag === undefined) {
    if (to === undefined) throw new Error('to is required and must be a non-empty string')
    return { to }
  }
  if (to !== undefined) {
    throw new Error(
      'name recipients in to, or a tag in to_tag, but not both — a tag already resolves to a set ' +
        'of sessions, and mixing the two hides which one actually decided the recipients',
    )
  }
  const problem = tagProblem(toTag)
  if (problem) throw new Error(`to_tag: ${problem}`)
  return { toTag }
}

/** Why one addressee of a multicast got nothing, in words a sender can act on. */
const MISS_REASON: Record<string, string> = {
  no_such_session: 'no active session',
  self: 'that is you',
  refused: 'refused by the broker',
}

/**
 * A multicast reports per recipient, because "ok" over a list of names hides the
 * one that failed — and the sender's next move (chase that peer, or not) depends
 * entirely on which one it was.
 */
function formatFanout(results: RecipientResult[], msgId: string | undefined, reason?: string): string {
  // `no_channel` counts as taken for the same reason `held` does — the message
  // is in that session's inbox — but it is called out separately below, because
  // a sender that reads only the first clause would wait for a reply that
  // nothing is going to prompt (CC-73).
  const took = results.filter(r => ['delivered', 'held', 'no_channel'].includes(r.status))
  const missed = results.filter(r => !took.includes(r))
  const parts: string[] = []
  if (took.length > 0) parts.push(`Delivered to ${took.map(r => r.name).join(', ')} (msg_id ${msgId})`)
  const held = took.filter(r => r.status === 'held')
  if (held.length > 0) parts.push(`held in the inbox of ${held.map(r => r.name).join(', ')}`)
  const unwoken = took.filter(r => r.status === 'no_channel')
  if (unwoken.length > 0)
    parts.push(
      `NOT WOKEN: ${unwoken.map(r => r.name).join(', ')} — started without agent-chat on --channels, so the ` +
        'message sits in the inbox unread until that session next looks. Do not wait on a reply',
    )
  if (missed.length > 0) {
    const each = missed.map(r => `${r.name} (${MISS_REASON[r.status] ?? r.status})`)
    parts.push(`not delivered to ${each.join(', ')}`)
  }
  const tail = reason ? ` ${reason}` : ''
  return `${parts.join('; ')}. ${took.length} of ${results.length}.${tail}`
}

function describeSend(res: SendResult, { to, toTag }: Target): string {
  if (!res.ok) return `Not delivered: ${res.reason}`
  // A tag reports per recipient for the same reason a multicast does, and more
  // so: the sender never named these sessions and cannot otherwise tell who the
  // tag actually resolved to.
  if (toTag !== undefined) return `Tag "${toTag}" — ${formatFanout(res.results ?? [], res.msgId, res.reason)}`
  if (Array.isArray(to)) return formatFanout(res.results ?? [], res.msgId, res.reason)
  if (res.held) return `Held for "${to}" (msg_id ${res.msgId}): ${res.reason}`
  return `Delivered to "${to}" (msg_id ${res.msgId}).`
}

export const chatSend = defineTool({
  name: 'chat_send',
  description:
    'Send a message to one other registered session by name, or to a named list of them. ' +
    'Fire-and-forget: the recipient sees it on ' +
    'their next turn and there is no reply unless they send one. Pass in_reply_to with a msg_id to answer ' +
    "a message. A successful send means the message reached the recipient's session process — NOT that " +
    'the recipient read or acted on it. Before sending a claim, quote what you OBSERVED rather than what ' +
    'you CONCLUDED: the raw log line, the exact output. A peer can check evidence; they cannot check your ' +
    'inference, and a wrong conclusion travels further than the observation that would refute it. ' +
    `Addressing several names costs the same fanout budget a broadcast does, and past ${MAX_MULTICAST_RECIPIENTS} ` +
    'names the call is refused — that many recipients is a broadcast, so send one. Each recipient is told ' +
    'who else received it, so say plainly who should act; otherwise everyone answers or nobody does. ' +
    'Use to_tag instead of to when you want whoever is doing a job rather than a peer you can name — ' +
    'it costs exactly what naming those sessions would, and a tag nobody carries is refused rather ' +
    'than quietly delivered to no one.',
  args,
  result: z.string(),
  async run(input, ctx) {
    const target = sendTarget(input)
    if (!ctx.registeredName) return 'Call chat_register before sending, so the recipient knows who you are.'
    const { to, toTag } = target
    // A hard cap, not a nudge: past this the call IS a broadcast, and letting it
    // through under a directed tool's name is how the fanout budget gets routed
    // around one name at a time.
    if (Array.isArray(to) && to.length > MAX_MULTICAST_RECIPIENTS) {
      return (
        `Refused: chat_send takes at most ${MAX_MULTICAST_RECIPIENTS} recipients and you named ` +
        `${to.length}. Use chat_broadcast, or pick the sessions that actually need this.`
      )
    }
    const inReplyTo = present(input.in_reply_to)
    const res = (await ctx.broker.request(
      {
        t: 'send',
        ...(to === undefined ? {} : { to }),
        ...(toTag === undefined ? {} : { toTag }),
        text: input.text,
        ...(inReplyTo === undefined ? {} : { inReplyTo }),
      },
      'send_result',
    )) as SendResult
    return describeSend(res, target)
  },
})
