import { warn } from './warnings.js'
import type { Allocation, IsolationContext, IsolationStrategy } from './index.js'

/**
 * Isolation by capability: the agent stays in the shared checkout but carries a
 * narrower toolset.
 *
 * Be honest about what this is. It restricts what an agent CAN DO, not where it
 * collides. A read-only explorer cannot conflict with anyone, which is a real
 * and useful form of isolation — but for an agent that writes, this is not a
 * substitute for `worktree` and must not be sold as one.
 */
export const toolsetStrategy: IsolationStrategy = {
  name: 'toolset-limited',

  async check(ctx: IsolationContext): Promise<string[]> {
    if (ctx.toolset?.allowedTools?.length) return []
    return [warn('toolset-limited with no allowedTools restricts nothing; the agent runs at full capability')]
  },

  async allocate(ctx: IsolationContext): Promise<Allocation> {
    const { allowedTools, disallowedTools } = ctx.toolset ?? {}
    return {
      cwd: ctx.baseCwd,
      ...(allowedTools ? { allowedTools: [...allowedTools] } : {}),
      ...(disallowedTools ? { disallowedTools: [...disallowedTools] } : {}),
      ...(allowedTools?.length ? { note: `Your tools are limited to: ${allowedTools.join(', ')}.` } : {}),
    }
  },

  async release(): Promise<boolean> {
    return true
  },
}
