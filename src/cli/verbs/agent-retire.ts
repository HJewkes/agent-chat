import { z } from 'zod'
import { requiredString } from '../../args.js'
import type { ServerMessage } from '../../protocol.js'
import { defineVerb, Report } from '../command.js'

/**
 * `--force` is the flag the isolation's own refusal has always told people to
 * use, and until CC-79 it did not exist anywhere: no option here, no field on
 * the wire, and `socket.ts` calling `retire(name)` with the parameter left at
 * its default. Someone whose worktree held uncommitted work was told to pass a
 * flag that was silently ignored, and had to remove the worktree by hand.
 */
export const agentRetire = defineVerb({
  name: 'agent.retire',
  description: 'release isolation, end the process, and free the name',
  args: z.object({ name: requiredString('name'), force: z.boolean().optional() }),
  result: Report,
  cli: {
    positional: ['name'],
    options: {
      force: {
        long: '--force',
        description: 'discard uncommitted or unmerged work the isolation is holding',
      },
    },
  },
  async run({ name, force }, ctx) {
    const res = (await ctx.withBroker(b =>
      b.request({ t: 'retire', name, ...(force === true ? { force: true } : {}) }, 'spawn_result'),
    )) as Extract<ServerMessage, { t: 'spawn_result' }>
    if (!res.ok) return { ok: false, lines: [`Not retired: ${res.reason}`] }
    // `reason` on a successful retire is a caveat, not a failure: what the broker
    // could not do (CC-77). Dropping it is what let a live process go unnoticed.
    const caveat = res.reason === undefined ? [] : [res.reason]
    return { ok: true, lines: [`Retired ${name}.`, ...caveat] }
  },
})
