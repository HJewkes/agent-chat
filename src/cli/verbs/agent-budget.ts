import { z } from 'zod'
import { agentBudget } from '../agents.js'
import { defineVerb, Report } from '../command.js'

/**
 * The peer-facing half of `session_budget` — what a planner reads before it
 * decides who gets the next task. `[name]` omitted lists every agent with a
 * reading, because the pacing question is usually "which of these is nearly
 * full", not "how is one of them doing".
 */
export const agentBudgetVerb = defineVerb({
  name: 'agent.budget',
  description: 'context fill and account rate limits, per agent',
  args: z.object({
    name: z.string().optional(),
    mine: z.boolean().optional(),
    spawner: z.string().optional(),
    prefix: z.string().optional(),
  }),
  result: Report,
  cli: {
    positional: ['name'],
    options: {
      mine: { long: '--mine', description: 'only agents you spawned (needs a registered session name)' },
      spawner: { long: '--spawner <name>', description: 'only agents spawned by <name>' },
      prefix: { long: '--prefix <p>', description: 'only agents whose name starts with <p>' },
    },
  },
  async run({ name, mine, spawner, prefix }) {
    return agentBudget(name, {
      ...(mine === undefined ? {} : { mine }),
      ...(spawner === undefined ? {} : { spawner }),
      ...(prefix === undefined ? {} : { prefix }),
    })
  },
})
