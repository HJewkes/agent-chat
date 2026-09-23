import { z } from 'zod'
import { patternList, present } from '../../args.js'
import type { ServerMessage } from '../../protocol.js'
import { defineTool } from '../command.js'

export const chatClaim = defineTool({
  name: 'chat_claim',
  description:
    'Say which worktree — and optionally which paths inside it — you are about to work in, so peers ' +
    'sharing that checkout find out BEFORE they overwrite you rather than after. Call it once you know ' +
    'what you will edit, and again to narrow or widen: re-claiming REPLACES your previous claim rather ' +
    'than adding to it. A claim overlapping one a peer already holds is refused and names them, which is ' +
    'your cue to message them rather than to retry. Two agents in DIFFERENT worktrees of the same ' +
    'repository never conflict, even on the same file — that is two branches, and git settles it at ' +
    'merge. Advisory, and worth being clear-eyed about: nothing intercepts a file write, so this records ' +
    'who got somewhere first and cannot stop a peer who never claims at all. Your claims are released ' +
    'when your session ends — a lease held by presence, not a lock anyone has to clean up.',
  args: z.object({
    patterns: z
      .array(z.string())
      .describe(
        'Path globs you intend to edit, relative to the worktree root, e.g. ["src/broker/**", ' +
          '"src/protocol.ts"]. `*` matches within a segment, `**` across segments. OMIT to claim the ' +
          'WHOLE worktree, which is exclusive and refuses every other claim in it.',
      )
      .optional(),
    worktree_path: z
      .string()
      .describe(
        'Absolute path of the worktree, when it is not the one this session runs in — for an agent ' +
          'working across several projects at once. You may hold claims in many repositories, but only ' +
          'ONE worktree per repository.',
      )
      .optional(),
  }),
  result: z.string(),
  async run(input, ctx) {
    const patterns = patternList('patterns', input.patterns)
    const worktreePath = present(input.worktree_path)
    const res = (await ctx.broker.request(
      {
        t: 'claim',
        ...(worktreePath === undefined ? {} : { worktreePath }),
        ...(patterns === undefined ? {} : { patterns }),
      },
      'claim_result',
    )) as Extract<ServerMessage, { t: 'claim_result' }>

    if (!res.ok) return res.reason ?? 'Claim refused.'
    const claim = res.claim
    if (claim === undefined) return 'Claimed.'
    const what = claim.kind === 'worktree' ? 'the whole worktree' : claim.patterns.join(', ')
    return (
      `Claimed ${what} in ${claim.worktreePath}. Peers see this in chat_list. It is advisory — it marks ` +
      `that you got there first, and does not prevent a write.`
    )
  },
})
