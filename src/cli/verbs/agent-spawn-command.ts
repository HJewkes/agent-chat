import { format } from 'node:util'
import { z } from 'zod'
import { SURFACE_NAMES } from '../../protocol.js'
import { agentSpawn } from '../agents.js'
import { defineVerb, Report } from '../command.js'

/** The existing human spawn effect retains ownership of identity, IO and explicit exits. */
export const agentSpawnVerb = defineVerb({
  name: 'agent.spawn',
  description: 'start a new agent',
  args: z.object({
    name: z.string(),
    profile: z.string(),
    brief: z.array(z.string()).optional(),
    briefing: z.string().optional(),
    briefStdin: z.boolean().optional(),
    configDir: z.string().optional(),
    task: z.string().optional(),
    role: z.string().optional(),
    surface: z.enum(SURFACE_NAMES).optional(),
    spawnedAs: z.enum(['shepherd', 'burndown']).optional(),
    remoteControl: z.boolean().optional(),
    host: z.string().optional(),
  }),
  result: Report,
  cli: {
    positional: ['name', 'profile', 'brief'],
    options: {
      briefing: {
        long: '--briefing',
        valueName: 'slug|auto',
        description: "prepend an active-work initiative's orientation to the brief",
      },
      briefStdin: {
        long: '--brief-stdin',
        description: 'read the brief from stdin, keeping it out of world-readable argv',
      },
      configDir: {
        long: '--config-dir',
        valueName: 'path',
        description: 'the Claude config dir, and therefore the account, to run it on',
      },
      task: {
        long: '--task',
        valueName: 'id',
        description: 'the task id the agent works on, recorded on its agent record',
      },
      role: {
        long: '--role',
        valueName: 'role',
        description: 'implementer, reviewer, fix-round-<n>, shepherd-review, planner or other',
      },
      surface: {
        long: '--surface',
        valueName: 'surface',
        description: "where it runs, overriding the profile's surface: " + SURFACE_NAMES.join(', '),
      },
      spawnedAs: {
        long: '--spawned-as',
        valueName: 'who',
        description: 'shepherd or burndown: the automation this spawn is on behalf of',
      },
      remoteControl: {
        long: '--remote-control',
        description: 'run with Remote Control (coordinator profiles only)',
      },
      host: {
        long: '--host',
        valueName: 'machine',
        description: 'the machine to launch on, a configured alias or a hostname (default: this one)',
      },
    },
  },
  async run({
    name,
    profile,
    brief,
    briefing,
    briefStdin,
    configDir,
    task,
    role,
    surface,
    spawnedAs,
    remoteControl,
    host,
  }) {
    try {
      await agentSpawn(name, profile, brief ?? [], {
        ...(briefing === undefined ? {} : { briefing }),
        ...(briefStdin === undefined ? {} : { briefStdin }),
        ...(configDir === undefined ? {} : { configDir }),
        ...(task === undefined ? {} : { task }),
        ...(role === undefined ? {} : { role }),
        ...(surface === undefined ? {} : { surface }),
        ...(spawnedAs === undefined ? {} : { spawnedAs }),
        ...(remoteControl === undefined ? {} : { remoteControl }),
        ...(host === undefined ? {} : { host }),
      })
      return { ok: true, lines: [] }
    } catch (error) {
      return { ok: false, lines: [], errors: [error instanceof Error ? error.message : format(error)] }
    }
  },
})
