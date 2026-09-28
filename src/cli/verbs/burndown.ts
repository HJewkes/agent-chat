import type { Command as Commander } from 'commander'
import { z } from 'zod'
import { burndownLedgerPath } from '../../paths.js'
import { readLedger } from '../../agents/burndown/ledger.js'
import { planFromDisk, renderPlan, renderStatus } from '../../agents/burndown/tick.js'
import { addVerb, defineVerb, Report } from '../command.js'

const refused = (err: unknown): Report => ({
  ok: false,
  lines: [],
  errors: [err instanceof Error ? err.message : String(err)],
})

export const burndownPlanVerb = defineVerb({
  name: 'burndown.plan',
  description: 'dry run: what the tick would dispatch now, and why every other task was refused',
  args: z.object({}),
  result: Report,
  async run() {
    const now = new Date()
    try {
      return { ok: true, lines: renderPlan(planFromDisk(now), now) }
    } catch (err) {
      return refused(err)
    }
  },
})

export const burndownStatusVerb = defineVerb({
  name: 'burndown.status',
  description: 'claim ledger, stalled claims and each account budget gate',
  args: z.object({}),
  result: Report,
  async run() {
    const now = new Date()
    try {
      return { ok: true, lines: renderStatus(readLedger(burndownLedgerPath()), now) }
    } catch (err) {
      return refused(err)
    }
  },
})

export function addBurndownCommands(program: Commander): void {
  const burndown = program
    .command('burndown')
    .description('pick unattended work for opted-in initiatives (dry run only in this build)')
  addVerb(burndown, burndownPlanVerb)
  addVerb(burndown, burndownStatusVerb)
}
