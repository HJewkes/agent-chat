import { z } from 'zod'
import { clampLimit, positiveLimit, requiredString } from '../../args.js'
import type { ServerMessage } from '../../protocol.js'
import { findDenials } from '../../agents/denials.js'
import { defineTool } from '../command.js'

/** Lower than chat_inbox's cap: a transcript scan is heavier than a message replay. */
const DENIALS_MAX = 20

export const agentLogs = defineTool({
  name: 'agent_logs',
  description:
    "Read a headless agent's own transcript for tool calls that were DENIED by a settings-level " +
    'permission rule (Claude Code writes `is_error: true` on the denied tool_result). Use this when ' +
    'an agent looks stuck and you suspect a permission denial rather than a crash. IMPORTANT LIMIT: ' +
    'this sees only ONE of two kinds of "blocked". A tool the agent\'s PROFILE never granted is absent ' +
    'from its schema entirely — there is no tool_use to deny, so it leaves no trace here at all. For ' +
    "that kind, check the profile's deny list instead (agent_profiles, or the denied-tools line from " +
    'agent_spawn). Empty output means no settings-level denial was found; it does not mean nothing was denied.',
  args: z.object({
    name: requiredString('name').describe('The agent, as shown by agent_list.'),
    limit: positiveLimit('limit')
      .describe(`How many recent denials to return (default 10, max ${DENIALS_MAX})`)
      .optional(),
  }),
  result: z.string(),
  async run({ name, limit }, ctx) {
    const res = (await ctx.broker.request({ t: 'agents' }, 'agents_result')) as Extract<
      ServerMessage,
      { t: 'agents_result' }
    >
    const agent = res.agents.find(a => a.name === name)
    if (agent === undefined) return `No agent named "${name}".`

    const denials = findDenials(
      agent.cwd,
      agent.sessionId,
      clampLimit(limit, 10, DENIALS_MAX),
      agent.configDir,
    )
    if (denials.length === 0)
      return (
        `No settings-level denials found in "${name}"'s transcript. This does not rule out a ` +
        "toolset-confined tool — that kind leaves no trace here; check the agent's deny list instead."
      )
    const rows = denials.map(d => `- ${d.tool}${d.kind ? ` (${d.kind})` : ''}: ${d.detail}`)
    return `Denials for "${name}":\n${rows.join('\n')}`
  },
})
