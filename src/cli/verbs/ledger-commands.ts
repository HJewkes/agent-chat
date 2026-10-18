import { format } from 'node:util'
import { z } from 'zod'
import { defineVerb, Report } from '../command.js'
import { doctorLifecycle } from '../doctor-lifecycle.js'
import { backfill } from '../lifecycle.js'

export const doctorLifecycleVerb = defineVerb({
  name: 'doctor.lifecycle',
  description: 'compare the shadow lifecycle ledger with the supervisor, the event log and git',
  args: z.object({ offline: z.boolean().optional() }),
  result: Report,
  cli: {
    options: {
      offline: {
        long: '--offline',
        description: 'skip the broker: compare the ledger, the event log, runtime.json and git only',
      },
    },
  },
  async run(args) {
    try {
      await doctorLifecycle({ ...(args.offline === undefined ? {} : { offline: args.offline }) })
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

export const lifecycleBackfillVerb = defineVerb({
  name: 'lifecycle.backfill',
  description:
    'write a ledger row for every non-retired spawned agent that has none; refuses while a broker runs',
  args: z.object({ dryRun: z.boolean().optional(), since: z.number().positive().optional() }),
  result: Report,
  cli: {
    options: {
      dryRun: {
        long: '--dry-run',
        description: 'print one line per agent that would get a row, and write nothing',
      },
      since: {
        long: '--since',
        valueName: 'days',
        description: 'only agents with an event in the last <days> days',
      },
    },
  },
  async run(args) {
    try {
      await backfill({
        ...(args.dryRun === undefined ? {} : { dryRun: args.dryRun }),
        ...(args.since === undefined ? {} : { since: args.since }),
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
