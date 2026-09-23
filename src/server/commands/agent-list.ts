import { z } from 'zod'
import type { AgentIdentity, ServerMessage } from '../../protocol.js'
import { accountUsageLine, budgetSegment, readBudget } from '../../agents/budget.js'
import { transcriptLine } from '../../agents/transcript.js'
import { defineTool } from '../command.js'

/** CC-126: a retired agent's name is gone, so its row names the session a spawn can continue. */
const resumeHint = (agent: AgentIdentity): string =>
  agent.state === 'retired' && agent.sessionId !== ''
    ? `\n    session: ${agent.sessionId} (agent_spawn resume_session brings it back)`
    : ''

export const agentList = defineTool({
  name: 'agent_list',
  description:
    'List durable agents with their lifecycle state and whether a process is currently attached. ' +
    'An agent can exist without being connected — identity outlives presence.',
  args: z.object({
    include_retired: z
      .boolean()
      .describe('Also list retired agents, with the session id agent_spawn resume_session needs.')
      .optional(),
  }),
  result: z.string(),
  async run({ include_retired }, ctx) {
    const includeRetired = include_retired === true
    const res = (await ctx.broker.request(
      { t: 'agents', ...(includeRetired ? { includeRetired } : {}) },
      'agents_result',
    )) as Extract<ServerMessage, { t: 'agents_result' }>
    if (res.agents.length === 0) return 'No agents.'
    // A budget reading is only ever meaningful for a live/attached process — a
    // spawning, detached, exited or retired identity has none to find, and on a
    // machine with a long agent history nearly every row is one of those. Reading
    // and rendering "no budget reading" on each would repeat one absence hundreds
    // of times over, which is worse than the thing CC-94 set out to fix.
    const budgets = res.agents
      .filter(a => a.state === 'live')
      // Under the agent's OWN recorded config dir (CC-100): an agent spawned from
      // a session on a dedicated account publishes its status there, not here.
      .map(a => ({ name: a.name, read: readBudget(a.sessionId, Date.now(), a.configDir) }))
    const budgetByName = new Map(budgets.map(b => [b.name, b.read]))
    const rows = res.agents.map(a => {
      // One extra segment, CC-94: budget rides in the same bracket as state
      // rather than adding a whole new line per row. Absent entirely for a
      // non-live row, rather than "no budget reading" — there, absence is the
      // default, not information.
      const read = budgetByName.get(a.name)
      const budgetPart = read === undefined ? '' : `, ${budgetSegment(read)}`
      return (
        // An adopted identity has no profile and no surface we chose, and its
        // name is self-reported — so it says what it is rather than rendering
        // two empty fields and reading like an agent someone spawned.
        `- ${a.name} [${a.state}, ${a.origin === 'adopted' ? 'human-started session' : `${a.profile}, ${a.surface}`}${budgetPart}]` +
        ` spawned by ${a.spawnedBy}\n    ${a.cwd}` +
        // A headless agent's output is discarded, so this is the only way to read
        // what it actually did without interrupting it for a report.
        `\n    ${transcriptLine(a.cwd, a.sessionId, a.configDir)}${resumeHint(a)}`
      )
    })
    return `Durable agents:\n${accountUsageLine(budgets, res.slots)}\n${rows.join('\n')}`
  },
})
