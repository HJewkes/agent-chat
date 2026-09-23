import { z } from 'zod'
import { requiredString } from '../../args.js'
import { teleportAbort } from '../agents.js'
import { defineVerb, Report } from '../command.js'

export const teleportAbortVerb = defineVerb({
  name: 'teleport.abort',
  description: 'stop a session ending itself for a successor',
  args: z.object({ name: requiredString('name') }),
  result: Report,
  cli: { positional: ['name'] },
  async run({ name }) {
    return teleportAbort(name)
  },
})
