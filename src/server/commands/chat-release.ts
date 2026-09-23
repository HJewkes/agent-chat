import { z } from 'zod'
import { present } from '../../args.js'
import type { ServerMessage } from '../../protocol.js'
import { defineTool } from '../command.js'

export const chatRelease = defineTool({
  name: 'chat_release',
  description:
    'Give up a claim once you are done with that area, so a peer waiting on it can take it without ' +
    'waiting for your session to end. Releases every claim you hold unless you name a worktree.',
  args: z.object({
    worktree_path: z
      .string()
      .describe('Release only the claim in this worktree. Omit to release everything you hold.')
      .optional(),
  }),
  result: z.string(),
  async run(input, ctx) {
    const worktreePath = present(input.worktree_path)
    const res = (await ctx.broker.request(
      { t: 'release', ...(worktreePath === undefined ? {} : { worktreePath }) },
      'release_result',
    )) as Extract<ServerMessage, { t: 'release_result' }>
    return res.released ? 'Released.' : 'You were not holding a claim there.'
  },
})
