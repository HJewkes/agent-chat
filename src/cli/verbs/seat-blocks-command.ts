import { format } from 'node:util'
import { z } from 'zod'
import { defineVerb, Report } from '../command.js'

export const seatBlocksVerb = defineVerb({
  name: 'seat-blocks',
  description: "each seat's blocked minutes over a window, and any block still open",
  args: z.object({ since: z.string().default('24h') }),
  result: Report,
  cli: {
    options: {
      since: { long: '--since', valueName: 'window', description: 'window such as 90m, 24h or 7d' },
    },
  },
  async run(options) {
    // Import failures retain the original immediate invocation failure boundary.
    const { seatBlocks } = await import('./seat-hook.js').catch(error => {
      throw new Error(error instanceof Error ? error.message : format(error))
    })
    try {
      // The original catch includes helper, join and synchronous stdout errors.
      console.log(seatBlocks(options).join('\n'))
      return { ok: true, lines: [] }
    } catch (error) {
      return {
        ok: false,
        lines: [],
        errors: [error instanceof Error ? error.message : String(error)],
        exit: 1,
      }
    }
  },
})
