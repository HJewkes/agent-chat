import { format } from 'node:util'
import { z } from 'zod'
import { defineVerb, Report } from '../command.js'
import { open } from '../service.js'
import { parsePort } from '../service-options.js'

export const serviceOpenVerb = defineVerb({
  name: 'service.open',
  description: 'open the dashboard, or print its URL when not a TTY',
  args: z.object({ port: z.preprocess(value => parsePort(String(value)), z.number()).optional() }),
  result: Report,
  cli: {
    options: {
      port: { short: '-p', long: '--port', valueName: 'port', description: 'port the dashboard is on' },
    },
  },
  async run({ port }) {
    try {
      await open(port === undefined ? {} : { port })
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
