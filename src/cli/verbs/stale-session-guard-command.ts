import { format } from 'node:util'
import { z } from 'zod'
import { defineVerb, Report } from '../command.js'

/** A hook keeps its existing direct stdout effect; registry dispatch adds no output. */
export const staleSessionGuardVerb = defineVerb({
  name: 'stale-session-guard',
  description: 'stop a superseded session before it receives a prompt',
  args: z.object({ agentId: z.string() }),
  result: Report,
  cli: { positional: ['agentId'] },
  async run({ agentId }) {
    try {
      const { staleSessionGuard } = await import('./stale-session-guard.js')
      staleSessionGuard(agentId)
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
