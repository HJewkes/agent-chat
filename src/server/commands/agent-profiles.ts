import { z } from 'zod'
import { loadProfile, roleOf, selectProfileNames } from '../../agents/profiles.js'
import { loadSeatPolicy, type SeatPolicyEntry } from '../../agents/seat-policy.js'
import { policySeat, rootSeatEntry } from '../../agents/seat-root.js'
import type { AgentProfile } from '../../agents/types.js'
import type { ServerMessage } from '../../protocol.js'
import { defineTool, type ToolContext } from '../command.js'

/** CC-1597: past this a compact row's description is cut, so the whole listing stays under 8k chars. */
const SUMMARY_CHARS = 100

const summary = (description: string): string => {
  const first = description.split(/(?<=\.)\s/)[0] ?? description
  return first.length <= SUMMARY_CHARS ? first : `${first.slice(0, SUMMARY_CHARS - 1).trimEnd()}…`
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

const heading = (name: string, profile: AgentProfile): string => {
  const effort = profile.effort === undefined ? '' : `, effort ${profile.effort}`
  return `- ${name} [${roleOf(profile)}, ${profile.model}${effort}, ${profile.surface}, isolation ${profile.isolation}, harness ${profile.harness ?? 'claude-code'}]`
}

function detailRow(name: string, profile: AgentProfile): string {
  const denies = profile.disallowedTools?.length ? `\n    denies: ${profile.disallowedTools.join(', ')}` : ''
  const warned = (profile.warnings ?? []).map(w => `\n    warning: ${w}`).join('')
  return `${heading(name, profile)}\n    ${profile.description}\n    tools: ${profile.allowedTools.join(', ')}${denies}${warned}`
}

/** CC-1597: one line, with the tool, deny and warning lists only counted. */
function compactRow(name: string, profile: AgentProfile): string {
  const counts = [
    plural(profile.allowedTools.length, 'tool'),
    `${profile.disallowedTools?.length ?? 0} denied`,
  ]
  if (profile.warnings?.length) counts.push(plural(profile.warnings.length, 'warning'))
  return `${heading(name, profile)} ${summary(profile.description)} (${counts.join(', ')})`
}

/**
 * CC-1616: the caller's seat ceiling, when the owner's policy lists its name and its live row is the
 * one the policy gives root. The broker still decides each spawn on the connection's own proof.
 */
async function ceilingLine(ctx: ToolContext): Promise<string> {
  const name = ctx.registeredName
  if (name === null || name === undefined) return ''
  const policy = loadSeatPolicy()
  if (policySeat(policy, name) === undefined) return ''
  const res = (await ctx.broker.request(
    { t: 'agents', view: { prefix: name, includeFinished: false, includeRetired: false } },
    'agents_result',
  )) as Extract<ServerMessage, { t: 'agents_result' }>
  const held = res.agents.some(a => a.name === name && a.state === 'live' && rootSeatEntry(a, policy))
  const entry: SeatPolicyEntry | undefined = held ? policySeat(policy, name) : undefined
  if (entry === undefined) return ''
  return `\nYou hold root seat "${name}" (seat-policy.json). Spawn ceiling, by profile name: ${entry.ceiling.join(', ') || 'none'}`
}

export const agentProfiles = defineTool({
  name: 'agent_profiles',
  description:
    "Call this automatically as step one of any spawn decision — even ones you're fairly sure about. " +
    "It's free, and guessing a profile name risks silently granting the wrong tool set. " +
    'List the profiles agent_spawn can use, with the role, model, surface and isolation each grants. ' +
    'Only a coordinator may spawn agents or run with Remote Control; a worker reports needs to its spawner. ' +
    'Pass name to read one profile with its tools and denies; an unknown name errors with close matches.',
  args: z.object({
    name: z.string().optional().describe('Return only this profile.'),
    verbose: z.boolean().optional().describe('Every profile with its tools and denies.'),
  }),
  result: z.string(),
  async run({ name: only, verbose }, ctx) {
    const render = only !== undefined || verbose === true ? detailRow : compactRow
    const rows = selectProfileNames(only).map(name => {
      const profile = loadProfile(name)
      return 'error' in profile ? `- ${name}: unreadable (${profile.error})` : render(name, profile)
    })
    if (rows.length === 0) return 'No profiles available.'
    const hint = render === compactRow ? ' (pass name for its tools and denies)' : ''
    return `Profiles for agent_spawn${hint}:\n${rows.join('\n')}${await ceilingLine(ctx)}`
  },
})
