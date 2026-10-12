import { z } from 'zod'
import { agentWorktrees } from '../agents.js'
import { defineVerb, Report } from '../command.js'

export const agentWorktreesVerb = defineVerb({
  name: 'agent.worktrees',
  description: 'worktrees agent-chat is holding, and which nobody is using',
  args: z.object({
    prune: z.boolean().optional(),
    force: z.boolean().optional(),
    json: z.boolean().optional(),
  }),
  result: Report,
  cli: {
    options: {
      prune: { long: '--prune', description: 'reclaim the ones nothing would be lost from' },
      force: { long: '--force', description: 'with --prune, reclaim even those holding work' },
      json: { long: '--json', description: 'per-repo headroom and rows as one JSON object' },
    },
  },
  async run({ prune, force, json }) {
    if (json === true && prune === true)
      return { ok: false, lines: [], errors: ['--json does not combine with --prune.'] }
    return agentWorktrees({
      ...(json === undefined ? {} : { json }),
      ...(prune === undefined ? {} : { prune }),
      ...(force === undefined ? {} : { force }),
    })
  },
})
