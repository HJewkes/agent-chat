import { z } from 'zod'
import { present } from '../../args.js'
import type { ServerMessage } from '../../protocol.js'
import { hostIdentity } from '../host.js'
import { budgetMiss, formatBudget, readBudget, type BudgetRead } from '../../agents/budget.js'
import { defineTool } from '../command.js'

const renderBudget = (who: string, read: BudgetRead): string =>
  read.found ? formatBudget(who, read) : budgetMiss(who, read)

export const sessionBudget = defineTool({
  name: 'session_budget',
  description:
    'How full your context window is and how much of the account rate-limit budget is gone — yours ' +
    "by default, or a peer's by name. Call it BEFORE the two decisions it exists for: teleporting " +
    'to a successor while there is still room to write the handoff, and spawning agents when the ' +
    'weekly window is nearly spent. Both are cheap early and impossible late. The numbers come from ' +
    'the status line, which Claude Code hands the real figures and which is the only place they leave ' +
    'the session — so a reading may be MISSING (nothing has written one) or STALE (that session has ' +
    'not redrawn since it went idle), and both are reported rather than smoothed over. Never read ' +
    'stale as current: an idle peer keeps publishing the fill it had when it stopped.',
  args: z.object({
    name: z
      .string()
      .describe('Session or agent to read, as shown by chat_list or agent_list. Omit to read your own.')
      .optional(),
  }),
  result: z.string(),
  async run({ name: rawName }, ctx) {
    const name = present(rawName)

    if (name === undefined || name === ctx.registeredName) {
      const { sessionId } = hostIdentity()
      if (sessionId === undefined)
        return (
          'No CLAUDE_CODE_SESSION_ID in this process, so there is no session to look a budget up for. ' +
          'That means this is not a Claude Code session.'
        )
      return renderBudget('You', readBudget(sessionId))
    }

    const res = (await ctx.broker.request({ t: 'agents' }, 'agents_result')) as Extract<
      ServerMessage,
      { t: 'agents_result' }
    >
    const agent = res.agents.find(a => a.name === name)
    if (agent === undefined)
      return (
        `No session or agent named "${name}" has a durable identity, so there is no session id to ` +
        'look a budget up for. chat_list shows who is registered; agent_list shows who has an identity.'
      )
    return renderBudget(name, readBudget(agent.sessionId, Date.now(), agent.configDir))
  },
})
