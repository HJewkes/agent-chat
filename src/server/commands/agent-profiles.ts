import { z } from 'zod'
import { loadProfile, roleOf, selectProfileNames } from '../../agents/profiles.js'
import type { AgentProfile } from '../../agents/types.js'
import { defineTool } from '../command.js'

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

export const agentProfiles = defineTool({
  name: 'agent_profiles',
  description:
    "Call this automatically as step one of any spawn decision — even ones you're fairly sure about. " +
    "It's free, and guessing a profile name risks silently granting the wrong tool set. " +
    'List the profiles agent_spawn can use, one line each with the role, model, surface and isolation each grants. ' +
    'Only a coordinator may spawn agents or run with Remote Control; a worker reports needs to its spawner. ' +
    'Pass name to read one profile in full, tools and denies included; an unknown name errors with close matches.',
  args: z.object({
    name: z.string().optional().describe('Return only this profile, in full.'),
    verbose: z.boolean().optional().describe('List every profile in full, tools and denies included.'),
  }),
  result: z.string(),
  async run({ name: only, verbose }) {
    const render = only !== undefined || verbose === true ? detailRow : compactRow
    const rows = selectProfileNames(only).map(name => {
      const profile = loadProfile(name)
      return 'error' in profile ? `- ${name}: unreadable (${profile.error})` : render(name, profile)
    })
    if (rows.length === 0) return 'No profiles available.'
    const hint = render === compactRow ? ' (pass name for its tools and denies)' : ''
    return `Profiles for agent_spawn${hint}:\n${rows.join('\n')}`
  },
})
