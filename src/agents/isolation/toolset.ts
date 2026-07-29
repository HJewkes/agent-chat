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
 *
 * And be honest about which list does the work: `allowedTools` GRANTS, it does
 * not confine. Only `disallowedTools` removes a tool, because a spawned agent
 * inherits the user's and project's settings and those can grant anything the
 * profile never mentioned.
 */
/**
 * What the agent is TOLD. Say only what is enforced.
 *
 * A read-only agent once ran Bash successfully and then reported that it had been
 * blocked, naming this note as the thing that stopped it — it believed its brief
 * over a tool_result in its own context. So a note claiming a limit we do not
 * enforce does not merely fail to help, it manufactures a confident false report.
 */
const noteFor = (allowed: readonly string[], denied: readonly string[] | undefined): string => {
  const limits = `Your tools are limited to: ${allowed.join(', ')}.`
  return denied?.length ? `${limits} ${denied.join(', ')} are unavailable to you.` : limits
}

export const toolsetStrategy: IsolationStrategy = {
  name: 'toolset-limited',

  async check(ctx: IsolationContext): Promise<string[]> {
    // Keyed on the DENY list, not the allow list. The earlier version of this
    // check fired only when allowedTools was empty — but a non-empty allow list
    // is exactly as unconfined, so the warning named the real failure mode and
    // then fired on the one condition where it did not apply. It read as proof
    // the case had been handled.
    if (ctx.toolset?.disallowedTools?.length) return []
    return [
      warn(
        'toolset-limited with no disallowedTools confines nothing: --allowed-tools grants ' +
          'permission but does not remove a tool, and the agent still inherits user and project ' +
          'settings that may allow more',
      ),
    ]
  },

  async allocate(ctx: IsolationContext): Promise<Allocation> {
    const { allowedTools, disallowedTools } = ctx.toolset ?? {}
    return {
      cwd: ctx.baseCwd,
      ...(allowedTools ? { allowedTools: [...allowedTools] } : {}),
      ...(disallowedTools ? { disallowedTools: [...disallowedTools] } : {}),
      ...(allowedTools?.length ? { note: noteFor(allowedTools, disallowedTools) } : {}),
    }
  },

  async release(): Promise<boolean> {
    return true
  },
}
