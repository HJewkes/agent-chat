import { z } from 'zod'
import { PERMISSION_BEHAVIORS, type ServerMessage } from '../../protocol.js'
import { describeApprove, isBehavior } from '../human.js'
import { defineVerb, Report } from '../command.js'

/**
 * A CLI verb and nothing else, for the same reason `endorse` is one: the broker
 * refuses this frame from any registered connection, so the only caller that can
 * reach it is a person at a 0600 socket. An agent granting a tool call — its own
 * or a peer's — is the thing this verb must never make reachable (ideas.md R1).
 *
 * `behavior` is a plain string, not a zod enum: a zod rejection would exit 64
 * (`EXIT.USAGE`), where the legacy usage refusal always exited 1. The field is
 * literally named `allow|deny` so the CLI positional renders as `<allow|deny>`
 * without needing G7's label support (`positionalSpec` names it after the key).
 */
export const approveVerb = defineVerb({
  name: 'human.approve',
  description: "answer an agent's permission prompt from here",
  args: z.object({ id: z.string(), 'allow|deny': z.string() }),
  result: Report,
  cli: { positional: ['id', 'allow|deny'] },
  async run(args, ctx) {
    const { id } = args
    const behavior = args['allow|deny']
    if (!isBehavior(behavior)) {
      return {
        ok: false,
        lines: [],
        errors: [`usage: agent-chat approve <id> ${PERMISSION_BEHAVIORS.join('|')}`],
      }
    }
    const res = (await ctx.withBroker(b =>
      b.request({ t: 'approve_permission', msgId: id, behavior }, 'answer_result'),
    )) as Extract<ServerMessage, { t: 'answer_result' }>
    return describeApprove(id, behavior, res)
  },
})
