import { z } from 'zod'
import { profiles } from '../agents.js'
import { defineVerb, Report } from '../command.js'

export const profilesVerb = defineVerb({
  name: 'profiles',
  description: 'agent profiles available to spawn with',
  args: z.object({}),
  result: Report,
  async run() {
    return profiles()
  },
})
