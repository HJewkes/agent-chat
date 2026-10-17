import { z } from 'zod'
import type { ServerMessage } from '../../protocol.js'
import { defineVerb, Report } from '../command.js'

/** Human CLI identity only: answers travel over an unregistered broker connection. */
export const answerVerb = defineVerb({
  name: 'human.answer',
  description: 'answer a question; routes back to the asker',
  args: z.object({ id: z.string(), text: z.array(z.string()) }),
  result: Report,
  cli: { positional: ['id', 'text'] },
  async run({ id, text }, ctx) {
    if (text.length === 0) return { ok: false, lines: [], errors: ['usage: agent-chat answer <id> <text>'] }
    try {
      const res = (await ctx.withBroker(b =>
        b.request({ t: 'answer', msgId: id, text: text.join(' ') }, 'answer_result'),
      )) as Extract<ServerMessage, { t: 'answer_result' }>
      if (!res.ok) return { ok: false, lines: [], errors: [res.reason ?? 'refused'] }
      return { ok: true, lines: [`Answered ${id}.${res.reason ? ` ${res.reason}` : ''}`] }
    } catch (error) {
      // The legacy CLI entrypoint maps every rejected action, including code 69, to exit 1.
      return { ok: false, lines: [], errors: [error instanceof Error ? error.message : String(error)] }
    }
  },
})
