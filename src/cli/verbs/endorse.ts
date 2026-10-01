import { z } from 'zod'
import { endorseCommand } from '../../endorse-command.js'
import type { ServerMessage } from '../../protocol.js'
import { describeEndorse } from '../human.js'
import { defineVerb, Report, type VerbContext } from '../command.js'

/** An open endorsement request as stored: the bytes and recipient an approval must restate. */
export interface Endorsement {
  msgId: string
  to: string
  text: string
}

async function approve({ msgId, to, text }: Endorsement, ctx: VerbContext): Promise<Report> {
  const res = (await ctx.withBroker(b =>
    b.request({ t: 'endorse_approve', msgId, text, to }, 'answer_result'),
  )) as Extract<ServerMessage, { t: 'answer_result' }>
  return describeEndorse(msgId, res)
}

async function stored(msgId: string, ctx: VerbContext): Promise<Endorsement | undefined> {
  const res = (await ctx.withBroker(b => b.request({ t: 'queue' }, 'queue_result'))) as Extract<
    ServerMessage,
    { t: 'queue_result' }
  >
  const item = res.items.find(i => i.msgId === msgId && i.kind === 'endorse_request')
  return item && { msgId, to: item.meta.recipient ?? '', text: item.text }
}

/** Recipient before and after the verbatim text, so a body cannot fake the line that names it. */
const show = ({ msgId, to, text }: Endorsement): string[] => [
  `Endorsement ${msgId} would be delivered to ${to}, with your authority. Text, verbatim:`,
  text,
  `(end of text, ${text.length} characters, to ${to})`,
]

/** What a caller with no terminal gets instead of a prompt: the command that restates the bytes. */
export const noTerminal = (e: Endorsement): string[] => [
  `refusing to endorse ${e.msgId} without a terminal to confirm at; to endorse these exact bytes, run:`,
  endorseCommand(e.msgId, e.to, e.text),
]

/**
 * A confused-agent control, not a guarantee (a pty wrapper defeats it): the
 * person reads the stored bytes and types `y` before they go out (CC-419).
 */
export async function confirmAndEndorse(e: Endorsement, ctx: VerbContext): Promise<Report> {
  if (!ctx.terminal?.isTTY) return { ok: false, lines: show(e), errors: noTerminal(e) }
  const answer = await ctx.terminal.ask([...show(e), 'Type y to endorse: '].join('\n'))
  if (answer.trim().toLowerCase() !== 'y')
    return { ok: false, lines: [], errors: [`Not endorsed ${e.msgId}; nothing sent.`] }
  return approve(e, ctx)
}

/**
 * A CLI verb and nothing else: the broker refuses this frame from any
 * registered connection, so the only caller that can reach it is a person at a
 * 0600 socket. The command restates the exact text and recipient (CC-418), so
 * what the person approving it read is what the broker delivers, or nothing.
 */
export const endorseVerb = defineVerb({
  name: 'human.endorse',
  description: 'approve a composed message; delivers it with your authority',
  args: z.object({ id: z.string(), to: z.string().optional(), text: z.string().optional() }),
  result: Report,
  cli: {
    positional: ['id'],
    options: {
      to: { long: '--to', description: 'the recipient the request names, exactly' },
      text: {
        long: '--text',
        description: 'the request text, byte for byte; without --to and --text, confirm at a terminal',
      },
    },
  },
  async run({ id, to, text }, ctx) {
    if (to !== undefined && text !== undefined) return approve({ msgId: id, to, text }, ctx)
    if (to !== undefined || text !== undefined)
      return {
        ok: false,
        lines: [],
        errors: ['give both --to and --text, or neither to confirm at a terminal'],
      }
    const request = await stored(id, ctx)
    if (request === undefined) return { ok: false, lines: [], errors: [`no open endorsement ${id}`] }
    return confirmAndEndorse(request, ctx)
  },
})
