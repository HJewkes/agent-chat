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
  args: z.object({ name: z.string().optional() }),
  result: Report,
  cli: { positional: ['name'] },
  async run({ name }) {
    return agentBudget(name)
  },
})
