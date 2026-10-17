import { format } from 'node:util'
import { z } from 'zod'
import { MAX_HOLD_SECONDS } from '../../broker/hold.js'
import { defineVerb, Report } from '../command.js'
import { start, stop, restart } from '../service.js'

export const serviceStartVerb = defineVerb({
  name: 'service.start',
  description: 'start the broker, detached by default',
  args: z.object({
    port: z.number().int().min(1).max(65535).optional(),
    foreground: z.boolean().optional(),
  }),
  result: Report,
  cli: {
    options: {
      port: { short: '-p', long: '--port', valueName: 'port', description: 'HTTP port to bind' },
      foreground: {
        short: '-f',
        long: '--foreground',
        description: 'run in this terminal instead of detaching',
      },
    },
  },
  async run(args) {
    try {
      await start({
        ...(args.port === undefined ? {} : { port: args.port }),
        ...(args.foreground === undefined ? {} : { foreground: args.foreground }),
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

export const serviceStopVerb = defineVerb({
  name: 'service.stop',
  description:
    'SIGTERM the broker, then SIGKILL if it lingers; refuses while an agent is mid-spawn; --hold keeps auto-starts off for a while',
  args: z.object({
    force: z.boolean().optional(),
    hold: z.number().int().min(1).max(MAX_HOLD_SECONDS).optional(),
  }),
  result: Report,
  cli: {
    options: {
      force: { long: '--force', description: 'stop even if a mid-spawn agent would be lost' },
      hold: {
        long: '--hold',
        valueName: 'seconds',
        description: `refuse broker starts, including auto-starts, for this long (at most ${MAX_HOLD_SECONDS})`,
      },
    },
  },
  async run(args) {
    try {
      await stop({
        ...(args.force === undefined ? {} : { force: args.force }),
        ...(args.hold === undefined ? {} : { hold: args.hold }),
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

export const serviceRestartVerb = defineVerb({
  name: 'service.restart',
  description: 'stop then start, reusing the port from broker.meta.json; refuses while an agent is mid-spawn',
  args: z.object({
    port: z.number().int().min(1).max(65535).optional(),
    force: z.boolean().optional(),
  }),
  result: Report,
  cli: {
    options: {
      port: {
        short: '-p',
        long: '--port',
        valueName: 'port',
        description: 'bind this port instead of the recorded one',
      },
      force: { long: '--force', description: 'restart even if a mid-spawn agent would be lost' },
    },
  },
  async run(args) {
    try {
      await restart({
        ...(args.port === undefined ? {} : { port: args.port }),
        ...(args.force === undefined ? {} : { force: args.force }),
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
