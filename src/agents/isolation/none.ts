import { warn } from './warnings.js'
import type { Allocation, IsolationContext, IsolationStrategy } from './index.js'

/**
 * No isolation: the agent works in the same checkout as everyone else.
 *
 * The correct default for `peer` agents, where coordination happens by
 * conversation rather than by partition. `check` warns instead of refusing —
 * sharing a tree with a human or another agent is the intended mode here, not
 * an error, and a refusal would make the common case impossible.
 */
export const noneStrategy: IsolationStrategy = {
  name: 'none',

  async check(ctx: IsolationContext): Promise<string[]> {
    const sharing = (ctx.peers ?? []).filter(p => p.agentId !== ctx.agentId && p.cwd === ctx.baseCwd)
    if (sharing.length === 0) return []
    return [
      warn(`sharing ${ctx.baseCwd} with ${sharing.map(p => p.name).join(', ')} — coordinate before editing`),
    ]
  },

  async allocate(ctx: IsolationContext): Promise<Allocation> {
    return { cwd: ctx.baseCwd }
  },

  async release(): Promise<boolean> {
    return true
  },
}
