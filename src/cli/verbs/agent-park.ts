import { z } from 'zod'
import { requiredString } from '../../args.js'
import type { ServerMessage } from '../../protocol.js'
import { defineVerb, Report } from '../command.js'

/** A broker started before CC-282 drops the frame unanswered, so the timeout is the only sign. */
function tooOld(err: unknown): never {
  if (!/did not answer/.test((err as Error).message)) throw err
  throw new Error('the broker did not answer park; it may predate CC-282, so restart the broker')
}

/** CC-282: the broker refuses a live, detached, dirty, unpushed or shared tree; `agent resume` brings it back. */
export const agentPark = defineVerb({
  name: 'agent.park',
  description: "remove an exited agent's clean, pushed worktree and keep its branch",
  args: z.object({ name: requiredString('name') }),
  result: Report,
  cli: { positional: ['name'] },
  async run({ name }, ctx) {
    const res = (await ctx
      .withBroker(b => b.request({ t: 'park', name }, 'spawn_result'))
      .catch(tooOld)) as Extract<ServerMessage, { t: 'spawn_result' }>
    if (!res.ok) return { ok: false, lines: [`Not parked: ${res.reason ?? 'no reason given'}`] }
    return {
      ok: true,
      lines: [res.reason ?? `Parked ${name}.`, `Bring it back with: agent-chat agent resume ${name}`],
    }
  },
})
