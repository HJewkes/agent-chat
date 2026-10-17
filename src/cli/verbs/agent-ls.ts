import { format } from 'node:util'
import { z } from 'zod'
import { agentLs } from '../agents.js'
import { defineVerb, Report } from '../command.js'

export const agentLsVerb = defineVerb({
  name: 'agent.ls',
  description: 'agents, with lifecycle and presence',
  args: z.object({
    json: z.boolean().optional(),
    mine: z.boolean().optional(),
    spawner: z.string().optional(),
    prefix: z.string().optional(),
    state: z.array(z.string()).optional(),
    name: z.string().optional(),
    format: z.string().optional(),
  }),
  result: Report,
  cli: {
    options: {
      json: { long: '--json', description: 'print one JSON array, one object per agent' },
      mine: { long: '--mine', description: 'only agents you spawned (needs a registered session name)' },
      spawner: { long: '--spawner', valueName: 'name', description: 'only agents spawned by <name>' },
      prefix: { long: '--prefix', valueName: 'p', description: 'only agents whose name starts with <p>' },
      state: {
        long: '--state',
        valueName: 'state',
        description: 'only agents showing this status, e.g. running, finished, retired (repeatable)',
      },
      name: { long: '--name', valueName: 'name', description: 'only the agent with exactly this name' },
      format: {
        long: '--format',
        valueName: 'format',
        description: 'line: one line per agent (name state profile id cwd)',
      },
    },
  },
  async run(options) {
    try {
      await agentLs({
        ...(options.json === undefined ? {} : { json: options.json }),
        ...(options.mine === undefined ? {} : { mine: options.mine }),
        ...(options.spawner === undefined ? {} : { spawner: options.spawner }),
        ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
        ...(options.state === undefined ? {} : { state: options.state }),
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.format === undefined ? {} : { format: options.format }),
      })
      return { ok: true, lines: [] }
    } catch (error) {
      return {
        ok: false,
        lines: [],
        errors: [error instanceof Error ? error.message : format(error)],
        exit: 1,
      }
    }
  },
})
