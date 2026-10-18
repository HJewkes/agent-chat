import { z } from 'zod'
import type { AgentIdentity, RosterHidden, RosterView, ServerMessage } from '../../protocol.js'
import { accountReader, accountUsageLines, budgetSegment, readBudget } from '../../agents/budget.js'
import { transcriptLine } from '../../agents/transcript.js'
import { accountName } from '../../agents/config-dir.js'
import { callerName, viewRoster } from '../../agents/roster-filter.js'
import { defineTool, type ToolContext } from '../command.js'

type AgentsResult = Extract<ServerMessage, { t: 'agents_result' }>

/** CC-126: a retired agent's name is gone, so its row names the session a spawn can continue. */
const resumeHint = (agent: AgentIdentity): string =>
  agent.state === 'retired' && agent.sessionId !== ''
    ? `\n    session: ${agent.sessionId} (agent_spawn resume_session brings it back)`
    : ''

/**
 * CC-217: the ledger's `live` only says a process attached. Unless a session of
 * that name is registered too, chat_list will not show it, so the row says so.
 */
const stateSegment = (agent: AgentIdentity, registered: ReadonlySet<string>): string =>
  agent.state === 'live' && !registered.has(agent.name) ? 'live, attached-unregistered' : agent.state

const DEFAULT_LIMIT = 50
/** A page past this overflows a coordinator's tool-result limit again. */
const MAX_LIMIT = 500

/** CC-1464: the footer that says the page is not the whole roster. */
const hiddenFooter = (hidden: RosterHidden, limit: number): string =>
  `${hidden.finished} finished, ${hidden.retired} retired not shown` +
  (hidden.overLimit > 0 ? `; ${hidden.overLimit} more past limit ${limit}` : '')

/**
 * CC-1464: the broker cuts the roster to `view` before sending it. An older broker
 * ignores `view`, so the same view runs here too; `includeRetired: true` makes that
 * broker send retired rows, so they are counted rather than silently missing.
 */
async function rosterPage(
  ctx: ToolContext,
  view: RosterView,
): Promise<{ agents: AgentIdentity[]; hidden: RosterHidden; slots: AgentsResult['slots'] }> {
  const res = (await ctx.broker.request(
    { t: 'agents', includeRetired: true, view },
    'agents_result',
  )) as AgentsResult
  const page = viewRoster(res.agents, view)
  return { agents: page.agents, hidden: res.hidden ?? page.hidden, slots: res.slots }
}

export const agentList = defineTool({
  name: 'agent_list',
  description:
    'List durable agents and whether a process is attached. Default: spawning, live, detached, newest first.',
  args: z.object({
    include_finished: z.boolean().describe('Also list exited agents.').optional(),
    include_retired: z
      .boolean()
      .describe('Also list retired agents, with the id resume_session needs.')
      .optional(),
    limit: z.number().describe(`Max rows (default ${DEFAULT_LIMIT}, cap ${MAX_LIMIT}).`).optional(),
    mine: z.boolean().describe('Only agents you spawned.').optional(),
    prefix: z.string().describe('Only names starting with this.').optional(),
  }),
  result: z.string(),
  async run({ include_finished, include_retired, limit: asked = DEFAULT_LIMIT, mine, prefix }, ctx) {
    const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(asked)))
    const { agents, hidden, slots } = await rosterPage(ctx, {
      ...(mine === true ? { spawner: callerName({ AGENT_CHAT_NAME: ctx.registeredName ?? undefined }) } : {}),
      ...(prefix === undefined ? {} : { prefix }),
      includeFinished: include_finished === true,
      includeRetired: include_retired === true,
      limit,
    })
    const footer = hiddenFooter(hidden, limit)
    if (agents.length === 0) return `No agents.\n${footer}`
    const { sessions } = (await ctx.broker.request({ t: 'list' }, 'list_result')) as Extract<
      ServerMessage,
      { t: 'list_result' }
    >
    const registered = new Set(sessions.map(s => s.name))
    // A budget reading is only ever meaningful for a live/attached process — a
    // spawning, detached, exited or retired identity has none to find, and on a
    // machine with a long agent history nearly every row is one of those. Reading
    // and rendering "no budget reading" on each would repeat one absence hundreds
    // of times over, which is worse than the thing CC-94 set out to fix.
    const live = agents.filter(a => a.state === 'live')
    // Under the agent's OWN recorded config dir (CC-100): an agent spawned from
    // a session on a dedicated account publishes its status there, not here.
    const budgets = live.map(a => ({
      name: a.name,
      read: readBudget(a.sessionId, Date.now(), a.configDir, a.cwd),
    }))
    // CC-491: from each account, not from rows; a headless row's transcript carries no rate limits.
    const account = accountReader()
    const accounts = [...new Set(live.map(a => account(a.configDir)))]
    const budgetByName = new Map(budgets.map(b => [b.name, b.read]))
    const rows = agents.map(a => {
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
        `- ${a.name} [${stateSegment(a, registered)}, ${a.origin === 'adopted' ? 'human-started session' : `${a.profile}, ${a.surface}`}${budgetPart}]` +
        ` spawned by ${a.spawnedBy}${a.configDir ? `, account: ${accountName(a.configDir)}` : ''}` +
        // CC-1059: the machine it launched on, so a row on another host reads as such.
        `${a.host ? `, host: ${a.host}` : ''}\n    ${a.cwd}` +
        // A headless agent's output is discarded, so this is the only way to read
        // what it actually did without interrupting it for a report.
        `\n    ${transcriptLine(a.cwd, a.sessionId, a.configDir)}${resumeHint(a)}`
      )
    })
    return `Durable agents:\n${accountUsageLines(accounts, slots)}\n${rows.join('\n')}\n${footer}`
  },
})
