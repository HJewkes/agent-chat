import { z } from 'zod'
import { listProfileNames, loadProfile } from '../../agents/profiles.js'
import { defineTool } from '../command.js'

export const agentProfiles = defineTool({
  name: 'agent_profiles',
  description:
    "Call this automatically as step one of any spawn decision — even ones you're fairly sure about. " +
    "It's free, and guessing a profile name risks silently granting the wrong tool set. " +
    'List the profiles agent_spawn can use, with the model, tool set, surface and isolation each grants.',
  args: z.object({}),
  result: z.string(),
  async run() {
    const rows = listProfileNames().map(name => {
      const profile = loadProfile(name)
      if ('error' in profile) return `- ${name}: unreadable (${profile.error})`
      const denies = profile.disallowedTools?.length
        ? `\n    denies: ${profile.disallowedTools.join(', ')}`
        : ''
      return (
        `- ${name} [${profile.model}, ${profile.surface}, isolation ${profile.isolation}]\n` +
        `    ${profile.description}\n    tools: ${profile.allowedTools.join(', ')}${denies}`
      )
    })
    return rows.length === 0 ? 'No profiles available.' : `Profiles for agent_spawn:\n${rows.join('\n')}`
  },
})
