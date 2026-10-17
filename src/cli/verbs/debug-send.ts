import { z } from 'zod'
import { WAKE_SOURCES, wakeSource, type ServerMessage } from '../../protocol.js'
import { defineVerb, Report, type Verb } from '../command.js'

const Args = z.object({ to: z.string(), text: z.array(z.string()), source: z.string().optional() })

/** Human CLI identity only; this must never become the registered-session MCP send command. */
const run: Verb<z.infer<typeof Args>>['run'] = async ({ to, text, source: requestedSource }, ctx) => {
  if (text.length === 0) return { ok: false, lines: [], errors: ['usage: agent-chat debug send <to> <text>'] }
  const source = requestedSource === undefined ? undefined : wakeSource(requestedSource)
  if (requestedSource !== undefined && source === undefined)
    return {
      ok: false,
      lines: [],
      errors: [`unknown --source "${requestedSource}"; known: ${WAKE_SOURCES.join(', ')}`],
    }
  try {
    const res = (await ctx.withBroker(b =>
      b.request(
        { t: 'human_send', to, text: text.join(' '), ...(source === undefined ? {} : { source }) },
        'send_result',
      ),
    )) as Extract<ServerMessage, { t: 'send_result' }>
    return {
      ok: res.ok,
      lines: [res.ok ? `Delivered to ${to} (msg_id ${res.msgId}).` : `Not delivered: ${res.reason}`],
    }
  } catch (error) {
    // The legacy CLI entrypoint maps every rejected send, including code 69, to exit 1.
    return { ok: false, lines: [], errors: [error instanceof Error ? error.message : String(error)] }
  }
}

export const debugSendVerb = defineVerb({
  name: 'debug.send',
  description: 'message a session as the human',
  args: Args,
  result: Report,
  cli: {
    positional: ['to', 'text'],
    options: {
      source: {
        long: '--source',
        valueName: 'source',
        description: 'record the send as made by this source (watchdog, shepherd) in the event log',
      },
    },
  },
  run,
})

/** Hidden relay alias retains no --source option, even though its action is shared. */
export const sendVerb = defineVerb({
  ...debugSendVerb,
  name: 'human.send',
  cli: { positional: ['to', 'text'] },
})
