import { z } from 'zod'
import { present, requiredString } from '../../args.js'
import type { ServerMessage } from '../../protocol.js'
import { defineTool } from '../command.js'

function describeTeleport(res: Extract<ServerMessage, { t: 'teleport_result' }>): string {
  if (!res.ok) return `Not teleporting: ${res.reason}`
  const warnings = (res.warnings ?? []).map(w => `\n  warning: ${w}`).join('')
  const when =
    res.countdownMs === undefined
      ? 'Your successor is starting now and this session is being shut down.'
      : `Your human has ${Math.round(res.countdownMs / 1000)}s to stop this, then you will be shut ` +
        'down and your successor will open in the same window.'
  return (
    `Teleport accepted. Handoff recorded; your successor is ${res.agentId} and keeps the name ` +
    `"${res.name}". ${when} Do not start anything new — finish or write down whatever is in ` +
    `flight, because it will not survive this turn.${warnings}`
  )
}

/**
 * Hand off and end this session. Nothing here names the subject: the broker resolves it from this
 * connection's own registry entry, which makes "teleport someone else" unrepresentable.
 */
export const agentTeleport = defineTool({
  name: 'agent_teleport',
  description:
    'End this session and start a successor that boots from the CURRENT build, keeping your name, ' +
    'your peers, your tags and your working directory. Use it when your own instructions or the code ' +
    'you run on have moved since you started — the alternative is exiting (losing what you know) or ' +
    'staying useful and stale. BUILD FIRST: the successor execs whatever `npm run build` last ' +
    'produced, so a teleport that skips the build achieves nothing at real cost. This is not a resume ' +
    'and not a subagent: your transcript does not come with you, the handoff below is all your ' +
    'successor gets, and you will be shut down. If you are visible in a terminal, your human gets 30 ' +
    'seconds to stop it; if you are headless it happens immediately. You cannot cancel it yourself. ' +
    'Answer or dismiss any open questions to the human first — teleport refuses while any are open.',
  args: z.object({
    handoff: requiredString('handoff').describe(
      'Everything your successor needs, written by you, stored verbatim, 8 KB max (refused, not ' +
        'truncated). Cover, in this order: (1) what you were mid-way through, in enough detail to ' +
        'resume without you; (2) state on disk — branch, uncommitted files, what builds and what ' +
        'does not; (3) what you would have done next, and why that and not the alternative; (4) ' +
        'what you already tried that did NOT work, which is the most expensive thing to lose; (5) ' +
        'who you owe a reply to and what you promised; (6) files to read first, in order, as ' +
        '@-prefixed absolute paths — Claude Code expands those into your successor’s first turn, ' +
        'so point at files instead of pasting them.',
    ),
    model: z
      .string()
      .describe(
        'Optional. Omit to keep running on the model you are on now, which is the usual case. Set ' +
          'it only to succeed yourself onto a different one deliberately — a cheaper model for a ' +
          'long grind, a stronger one for what is left.',
      )
      .optional(),
  }),
  result: z.string(),
  async run({ handoff, model: requested }, ctx) {
    if (ctx.registeredName === null)
      return (
        'Register with chat_register first: teleport hands your name to a successor, and you do not ' +
        'have one yet.'
      )
    const model = present(requested)
    const res = (await ctx.broker.request(
      { t: 'teleport', handoff, ...(model === undefined ? {} : { model }) },
      'teleport_result',
    )) as Extract<ServerMessage, { t: 'teleport_result' }>
    return describeTeleport(res)
  },
})
