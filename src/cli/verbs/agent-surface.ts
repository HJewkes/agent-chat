import { z } from 'zod'
import { requiredString } from '../../args.js'
import { agentSurface } from '../agents.js'
import { defineVerb, Report } from '../command.js'

export const agentSurfaceVerb = defineVerb({
  name: 'agent.surface',
  description: 'bring a headless agent into a window you can answer',
  args: z.object({ name: requiredString('name') }),
  result: Report,
  cli: { positional: ['name'] },
  async run({ name }) {
    return agentSurface(name)
  },
})
