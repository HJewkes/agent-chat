import { z } from 'zod'
import type { ServerMessage } from '../../protocol.js'
import { defineTool } from '../command.js'

export const agentBackground = defineTool({
  name: 'agent_background',
  description:
    'Send YOURSELF headless, releasing the terminal window you are in. This names no agent and ' +
    'cannot be aimed at one: you may only background yourself. Your name, identity and conversation ' +
    'all survive. Understand what you are giving up before calling it — headless sessions are never ' +
    'shown permission prompts, so anything needing approval will be denied outright rather than ' +
    'asked about, and nobody is watching a pane for you. Do not background yourself while you are ' +
    'blocked on something, or expect to be.',
  args: z.object({}),
  result: z.string(),
  async run(_args, ctx) {
    if (ctx.registeredName === null)
      return 'Register with chat_register first: going headless keeps your identity, and you have none yet.'
    const res = (await ctx.broker.request({ t: 'background' }, 'switch_result')) as Extract<
      ServerMessage,
      { t: 'switch_result' }
    >
    if (!res.ok) return `Not going headless: ${res.reason}`
    return (
      'Going headless. This session is being shut down and resumed without a window, keeping your ' +
      'name and your conversation. Do not start anything new — the turn you are in now will not ' +
      'survive it.'
    )
  },
})
