import { z } from 'zod'
import { requiredString } from '../../args.js'
import { activeWorkRoot } from '../../agents/active-work.js'
import { landedSweepFromDisk, renderLandedSweep } from '../../agents/burndown/landed-sweep.js'
import { defaultAutonomyRoot } from '../../agents/burndown/policy.js'
import { defineVerb, Report } from '../command.js'

const DEFAULT_DAYS = 7

export const burndownLandedVerb = defineVerb({
  name: 'burndown.landed',
  description:
    "every open, unreconciled task in a seat's scope that a recent default-branch subject names (CC-611); writes nothing",
  args: z.object({
    seat: requiredString('seat'),
    days: z.coerce.number().int().positive().optional(),
    json: z.boolean().optional(),
    autonomyRoot: z.string().optional(),
  }),
  result: Report,
  cli: {
    options: {
      seat: { long: '--seat', description: 'autonomy seat whose scope and repos to sweep' },
      days: { long: '--days', description: `subjects from the last N days (default ${DEFAULT_DAYS})` },
      json: { long: '--json', description: 'one JSON record per row, one per line' },
      autonomyRoot: { long: '--autonomy-root', description: 'directory holding charter.md and seats/' },
    },
  },
  async run({ seat, days, json, autonomyRoot }) {
    try {
      const sweep = landedSweepFromDisk({
        seat,
        days: days ?? DEFAULT_DAYS,
        autonomyRoot: autonomyRoot ?? defaultAutonomyRoot(),
        activeWorkRoot: activeWorkRoot(),
      })
      const lines = json === true ? sweep.rows.map(row => JSON.stringify(row)) : renderLandedSweep(sweep)
      return { ok: true, lines }
    } catch (err) {
      return { ok: false, lines: [], errors: [err instanceof Error ? err.message : String(err)] }
    }
  },
})
