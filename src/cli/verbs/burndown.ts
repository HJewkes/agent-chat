import fs from 'node:fs'
import type { Command as Commander } from 'commander'
import { z } from 'zod'
import { requiredString } from '../../args.js'
import { burndownLedgerPath, burndownPausePath } from '../../paths.js'
import { readLedger, withLedgerLock, writeLedger } from '../../agents/burndown/ledger.js'
import { tickFromDisk } from '../../agents/burndown/run-tick.js'
import { planFromDisk, renderPlan, renderStatus } from '../../agents/burndown/tick.js'
import { BrokerClient } from '../../client/broker-client.js'
import { addVerb, defineVerb, Report } from '../command.js'
import { tickBroker } from '../burndown-broker.js'

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

export const burndownTickVerb = defineVerb({
  name: 'burndown.tick',
  description: 'one pass: advance every claim a phase, then spawn new work inside the ceilings',
  args: z.object({ once: z.boolean().optional(), dryRun: z.boolean().optional() }),
  result: Report,
  cli: {
    options: {
      once: { long: '--once', description: "run one pass and exit (required; the schedule is launchd's)" },
      dryRun: { long: '--dry-run', description: 'print the steps without writing the ledger or spawning' },
    },
  },
  async run({ once, dryRun }) {
    if (once !== true) return refused(new Error('burndown tick runs one pass only; pass --once'))
    // Never autostart: a tick that brought up a broker would own it, and the broker serves every session.
    const client = new BrokerClient(() => undefined, undefined, undefined, undefined, undefined, {
      autoStart: false,
    })
    try {
      await client.connect()
      return { ok: true, lines: await tickFromDisk({ dryRun: dryRun === true, broker: tickBroker(client) }) }
    } catch (err) {
      return refused(err)
    } finally {
      client.close()
    }
  },
})

export const burndownPauseVerb = defineVerb({
  name: 'burndown.pause',
  description: 'stop new spawns from the next tick on; running agents finish',
  args: z.object({}),
  result: Report,
  async run() {
    fs.writeFileSync(burndownPausePath(), `${new Date().toISOString()}\n`)
    return { ok: true, lines: [`paused: ${burndownPausePath()} written`] }
  },
})

export const burndownResumeVerb = defineVerb({
  name: 'burndown.resume',
  description: 'let the tick spawn again',
  args: z.object({}),
  result: Report,
  async run() {
    fs.rmSync(burndownPausePath(), { force: true })
    return { ok: true, lines: ['resumed'] }
  },
})

export const burndownReleaseVerb = defineVerb({
  name: 'burndown.release',
  description: 'drop every claim on a task, stalled or not, so the tick may pick it again',
  args: z.object({ task: requiredString('task') }),
  result: Report,
  cli: { positional: ['task'] },
  async run({ task }) {
    const file = burndownLedgerPath()
    const locked = await withLedgerLock(file, () => {
      const ledger = readLedger(file)
      const dropped = ledger.claims.filter(c => c.taskId === task && c.phase !== 'done')
      writeLedger(file, { ...ledger, claims: ledger.claims.filter(c => !dropped.includes(c)) })
      return dropped
    })
    if (!locked.ran)
      return refused(new Error(`a tick holds the ledger lock (pid ${locked.holder}); try again`))
    if (locked.value.length === 0) return { ok: false, lines: [], errors: [`no held claim on ${task}`] }
    return {
      ok: true,
      lines: locked.value.map(
        c =>
          `released ${c.taskId}${c.slice === undefined ? '' : ` slice ${c.slice}`} (${c.phase}${c.stalledReason === undefined ? '' : `, stalled: ${c.stalledReason}`})`,
      ),
    }
  },
})

export function addBurndownCommands(program: Commander): void {
  const burndown = program
    .command('burndown')
    .description('pick and run unattended work for opted-in initiatives')
  addVerb(burndown, burndownPlanVerb)
  addVerb(burndown, burndownStatusVerb)
  addVerb(burndown, burndownTickVerb)
  addVerb(burndown, burndownPauseVerb)
  addVerb(burndown, burndownResumeVerb)
  addVerb(burndown, burndownReleaseVerb)
}
