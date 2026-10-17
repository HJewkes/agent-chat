import { format } from 'node:util'
import { z } from 'zod'
import { defineVerb, Report } from '../command.js'
import { watch } from '../watch.js'

export const watchVerb = defineVerb({
  name: 'watch',
  description: 'stream messages for a session that cannot receive channel pushes',
  args: z.object({
    name: z.string(),
    since: z.string().default('now'),
    interval: z.string().default('2'),
    once: z.boolean().optional(),
  }),
  result: Report,
  cli: {
    positional: ['name'],
    options: {
      since: {
        long: '--since',
        valueName: 'id|now|all',
        description: 'start from a log id, the current head, or the whole backlog',
      },
      interval: { long: '--interval', valueName: 'seconds', description: 'how often to poll' },
      once: { long: '--once', description: 'print what is waiting and exit, instead of following' },
    },
  },
  async run({ name, since, interval, once }) {
    try {
      await watch(name, { since, interval, ...(once === undefined ? {} : { once }) })
      return { ok: true, lines: [] }
    } catch (error) {
      return {
        ok: false,
        lines: [],
        errors: [error instanceof Error ? error.message : format(error)],
        exit: 1,
      }
    }
  },
})
