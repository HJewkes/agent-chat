import { z } from 'zod'
import { loadProfile, roleOf, selectProfileNames } from '../../agents/profiles.js'
import { defineTool } from '../command.js'

export const agentProfiles = defineTool({
  name: 'agent_profiles',
  description:
    "Call this automatically as step one of any spawn decision — even ones you're fairly sure about. " +
    "It's free, and guessing a profile name risks silently granting the wrong tool set. " +
    'List the profiles agent_spawn can use, with the role, model, tool set, surface and isolation each grants. ' +
    'Only a coordinator may spawn agents or run with Remote Control; a worker reports needs to its spawner. ' +
    'Pass name to read one profile; an unknown name errors with close matches.',
  args: z.object({ name: z.string().optional().describe('Return only this profile.') }),
  result: z.string(),
  async run({ name: only }) {
    const rows = selectProfileNames(only).map(name => {
      const profile = loadProfile(name)
      if ('error' in profile) return `- ${name}: unreadable (${profile.error})`
      const denies = profile.disallowedTools?.length
        ? `\n    denies: ${profile.disallowedTools.join(', ')}`
        : ''
      const effort = profile.effort === undefined ? '' : `, effort ${profile.effort}`
      const warned = (profile.warnings ?? []).map(w => `\n    warning: ${w}`).join('')
      return (
        `- ${name} [${roleOf(profile)}, ${profile.model}${effort}, ${profile.surface}, isolation ${profile.isolation}]\n` +
        `    ${profile.description}\n    tools: ${profile.allowedTools.join(', ')}${denies}${warned}`
      )
    })
    return rows.length === 0 ? 'No profiles available.' : `Profiles for agent_spawn:\n${rows.join('\n')}`
  },
})
