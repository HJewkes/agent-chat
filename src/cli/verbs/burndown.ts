import type { Command as Commander } from 'commander'
import { z } from 'zod'
import { requiredString } from '../../args.js'
import { burndownLedgerPath } from '../../paths.js'
import { activeWorkRoot } from '../../agents/active-work.js'
import { defaultAutonomyRoot } from '../../agents/burndown/policy.js'
import { renderScored, scoredPlanFromDisk } from '../../agents/burndown/score-render.js'
import { renderMilestoneLine } from '../../agents/burndown/milestone-report.js'
import { milestoneReportFromDisk, type MilestoneReportRead } from '../../agents/burndown/milestone-source.js'
import { localDate, watchdogUnusable } from '../../agents/burndown/seat-tick.js'
import { logEvent } from '../../broker/log.js'
import { collisionCheck, type BrokerView } from '../../agents/burndown/collision.js'
import { claimCustody } from '../../agents/burndown/custody.js'
import { shepherdRows, shepherdTarget } from '../../agents/burndown/shepherd.js'
import { heldClaims, readLedger, withLedgerLock, writeLedger } from '../../agents/burndown/ledger.js'
import { tickFromDisk } from '../../agents/burndown/run-tick.js'
import {
  DEFAULT_WINDOW,
  briefSourceQuality,
  dispatchStats,
  parseWindow,
  renderBriefSourceQuality,
  renderDispatchStats,
  type DispatchStatsPorts,
} from '../../agents/burndown/dispatch-stats.js'
import { dispatchStatsPorts } from '../../agents/burndown/dispatch-stats-source.js'
import { seatCompareFromDisk } from '../../agents/burndown/seat-compare.js'
import {
  planFromDisk,
  renderPlan,
  renderStatus,
  seatPlanFromDisk,
  type SeatPlanOptions,
} from '../../agents/burndown/tick.js'
import { BrokerClient } from '../../client/broker-client.js'
import { systemHost } from '../../mirror/job-host.js'
import { addVerb, defineVerb, Report } from '../command.js'
import { collisionView, tickBroker } from '../burndown-broker.js'
import { approveBrief, approvePortsOn } from '../../agents/burndown/brief-approve.js'
import { linkSlicePr, releaseTask, type RetireCall } from './burndown-release.js'
import { unstallSlice } from './burndown-unstall.js'
import { changedFiles } from '../../agents/burndown/observe.js'
import { diskPlanReader } from '../../agents/burndown/seed-slices.js'
import {
  burndownConfigShowVerb,
  burndownOverrideClearVerb,
  burndownOverrideSetVerb,
  burndownPresetApplyVerb,
  burndownPresetClearVerb,
  burndownPresetListVerb,
  burndownSeatOffVerb,
  burndownSeatOnVerb,
  pauseByArgs,
  pauseByCli,
  pauseFromCli,
} from './burndown-config.js'
import { burndownInstallOn, burndownJobStatusOn, burndownUninstallOn } from './burndown-job.js'
import { burndownLandedVerb } from './burndown-landed.js'
import { kicksInBroker, sendJobKick } from './job-kick.js'

const refused = (err: unknown): Report => ({
  ok: false,
  lines: [],
  errors: [err instanceof Error ? err.message : String(err)],
})

const PlanArgs = z.object({
  seat: z.string().optional(),
  scored: z.boolean().optional(),
  top: z.coerce.number().int().positive().optional(),
  autonomyRoot: z.string().optional(),
  today: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
    .optional(),
})
type PlanArgs = z.infer<typeof PlanArgs>

/** score.py's default `--top`. */
const DEFAULT_TOP = 20

/** Refuses scored-only flags without `--scored`, so a plain `burndown plan` never changes meaning. */
export function planFlagError({ seat, scored, top, autonomyRoot, today }: PlanArgs): string | undefined {
  if (scored === true) return seat === undefined ? 'burndown plan --scored needs --seat <name>' : undefined
  if (seat !== undefined)
    return top === undefined && today === undefined
      ? undefined
      : 'burndown plan --top and --today apply only with --seat <name> --scored'
  if (top !== undefined || autonomyRoot !== undefined || today !== undefined)
    return 'burndown plan --top, --autonomy-root and --today apply only with --seat <name> --scored'
  return undefined
}

export const burndownPlanVerb = defineVerb({
  name: 'burndown.plan',
  description: 'dry run: what the tick would dispatch now, and why every other task was refused',
  args: PlanArgs,
  result: Report,
  cli: {
    options: {
      seat: { long: '--seat', description: 'autonomy seat whose dry-run dispatch plan to print' },
      scored: { long: '--scored', description: "print the seat's scored dispatch order with components" },
      top: { long: '--top', description: `picks to print with --scored (default ${DEFAULT_TOP})` },
      autonomyRoot: { long: '--autonomy-root', description: 'directory holding charter.md and seats/' },
      today: { long: '--today', description: 'pin the staleness clock (YYYY-MM-DD) with --scored' },
    },
  },
  async run(args) {
    const flagError = planFlagError(args)
    if (flagError !== undefined) return refused(new Error(flagError))
    try {
      if (args.seat === undefined) return await plainPlan()
      if (args.scored === true) return { ok: true, lines: scoredSeatPlan(args.seat, args) }
      return await seatDispatchPlan(args.seat, args.autonomyRoot)
    } catch (err) {
      return refused(err)
    }
  },
})

async function plainPlan(): Promise<Report> {
  const now = new Date()
  const broker = await readCollisionView()
  const planned = planFromDisk(now, undefined, ledger => collisionCheck(ledger, broker))
  return { ok: true, lines: renderPlan(planned, now) }
}

async function seatDispatchPlan(seat: string, autonomyRoot: string | undefined): Promise<Report> {
  const unusable = watchdogUnusable()
  if (unusable !== undefined) {
    logEvent('burndown_seat_paths_skipped', { reason: unusable })
    const plain = await plainPlan()
    return {
      ...plain,
      lines: [`seat paths skipped, showing the legacy plan: ${unusable}`, ...plain.lines],
    }
  }
  const opts = await seatPlanOptions(seat, autonomyRoot)
  return { ok: true, lines: renderPlan(seatPlanFromDisk(opts), opts.now) }
}

export const burndownSeatsCompareVerb = defineVerb({
  name: 'burndown.seats.compare',
  description:
    "check a seat's dry-run plan against score.py: each ID dispatched in order, refused, held or beyond caps",
  args: z.object({ seat: requiredString('seat'), autonomyRoot: z.string().optional() }),
  result: Report,
  cli: {
    options: {
      seat: { long: '--seat', description: 'autonomy seat to compare' },
      autonomyRoot: {
        long: '--autonomy-root',
        description: 'directory holding score.py, charter.md and seats/',
      },
    },
  },
  async run({ seat, autonomyRoot }) {
    try {
      return seatCompareFromDisk(await seatPlanOptions(seat, autonomyRoot))
    } catch (err) {
      return refused(err)
    }
  },
})

/**
 * The seat plan's live inputs. The collision view and the roster are read apart, so a roster read
 * that fails only counts every held tree instead of losing the view and refusing every task as `claimed`.
 */
export async function seatPlanOptions(
  seat: string,
  autonomyRoot: string | undefined,
): Promise<SeatPlanOptions> {
  const view = await readCollisionView()
  const roster = await readBroker(client => tickBroker(client).roster())
  const root = activeWorkRoot()
  return {
    seat,
    now: new Date(),
    root,
    autonomyRoot: autonomyRoot ?? defaultAutonomyRoot(root),
    collision: ledger => collisionCheck(ledger, view),
    ...(roster === undefined ? {} : { roster }),
  }
}

function scoredSeatPlan(seat: string, { top, autonomyRoot, today }: PlanArgs): string[] {
  const plan = scoredPlanFromDisk({
    seat,
    top: top ?? DEFAULT_TOP,
    today: today ?? localDate(new Date()),
    autonomyRoot: autonomyRoot ?? defaultAutonomyRoot(),
    activeWorkRoot: activeWorkRoot(),
  })
  return renderScored(plan)
}

const readCollisionView = (): Promise<BrokerView | undefined> => readBroker(collisionView)

/** Undefined when no broker answers, which the collision check reports as a `claimed` refusal it could not rule out. */
async function readBroker<T>(read: (client: BrokerClient) => Promise<T>): Promise<T | undefined> {
  const client = new BrokerClient(() => undefined, undefined, undefined, undefined, undefined, {
    autoStart: false,
  })
  try {
    await client.connect()
    return await read(client)
  } catch {
    return undefined
  } finally {
    client.close()
  }
}

/** The milestone verb's body, taking its reader explicitly so a test can point it at a fixture. */
export function milestoneReportLines(read: () => MilestoneReportRead | undefined, json: boolean): Report {
  try {
    const doc = read()
    if (doc === undefined) throw new Error('no milestones/<week>.yml for this ISO week')
    if (json) return { ok: true, lines: [JSON.stringify(doc, null, 2)] }
    const errors = doc.errors.length > 0 ? [`milestone file errors: ${doc.errors.join('; ')}`] : []
    return { ok: true, lines: [...doc.milestones.map(renderMilestoneLine), ...errors] }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    return json ? { ok: false, lines: [JSON.stringify({ error }, null, 2)] } : refused(err)
  }
}

export const burndownMilestoneVerb = defineVerb({
  name: 'burndown.milestone',
  description:
    "this week's burn-down per milestone: points, critical path, WIP, throughput, forecast, status",
  args: z.object({ json: z.boolean().optional(), autonomyRoot: z.string().optional() }),
  result: Report,
  cli: {
    options: {
      json: { long: '--json', description: 'one JSON document; a failure is {"error"} with exit 1' },
      autonomyRoot: { long: '--autonomy-root', description: 'directory holding milestones/<week>.yml' },
    },
  },
  async run({ json, autonomyRoot }) {
    const now = new Date()
    const read = () =>
      milestoneReportFromDisk({
        autonomyRoot: autonomyRoot ?? defaultAutonomyRoot(),
        activeWorkRoot: activeWorkRoot(),
        now,
        today: localDate(now),
      })
    return milestoneReportLines(read, json === true)
  },
})

/** The dispatch-stats verb's body, taking its ports explicitly so a test can point it at fixtures. */
export function dispatchStatsLines(
  ports: DispatchStatsPorts,
  since: string,
  json: boolean,
  byBriefSource = false,
  floor?: number,
): Report {
  const windowMs = parseWindow(since)
  if (windowMs === undefined)
    return refused(new Error(`--since ${since} is not a window; use e.g. 90m, 24h or 7d`))
  try {
    if (byBriefSource) {
      const quality = briefSourceQuality(ports, windowMs)
      return {
        ok: true,
        lines: json ? quality.map(q => JSON.stringify(q)) : renderBriefSourceQuality(quality),
      }
    }
    const stats = dispatchStats(ports, windowMs, floor)
    return { ok: true, lines: json ? stats.map(s => JSON.stringify(s)) : renderDispatchStats(stats) }
  } catch (err) {
    return refused(err)
  }
}

export const burndownDispatchStatsVerb = defineVerb({
  name: 'burndown.dispatch-stats',
  description:
    'per seat: spawns/h tick vs hand, queue age, ready depth, cap use, refusal mix, registrations, tick health',
  args: z.object({
    json: z.boolean().optional(),
    since: z.string().optional(),
    byBriefSource: z.boolean().optional(),
    floor: z.coerce.number().int().positive().optional(),
    autonomyRoot: z.string().optional(),
  }),
  result: Report,
  cli: {
    options: {
      json: {
        long: '--json',
        description: 'one JSON record per seat (per brief source with --by-brief-source), one per line',
      },
      byBriefSource: {
        long: '--by-brief-source',
        description:
          'instead: fix rounds and FIX_FIRST verdicts by who wrote the brief (seat, briefer, template, unknown)',
      },
      since: {
        long: '--since',
        description: `window to read, e.g. 90m, 24h or 7d (default ${DEFAULT_WINDOW})`,
      },
      floor: {
        long: '--floor',
        description: 'ready depth floor to count breaches against (default 2 x the tick config maxAgents)',
      },
      autonomyRoot: { long: '--autonomy-root', description: 'directory holding seats/ and logs/' },
    },
  },
  async run({ json, since, byBriefSource, floor, autonomyRoot }) {
    const ports = dispatchStatsPorts(autonomyRoot ?? defaultAutonomyRoot(), new Date())
    return dispatchStatsLines(ports, since ?? DEFAULT_WINDOW, json === true, byBriefSource === true, floor)
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
      const ledger = readLedger(burndownLedgerPath())
      const held = heldClaims(ledger)
      const shepherd = held.some(c => shepherdTarget(c.pr) !== undefined) ? shepherdRows() : []
      return { ok: true, lines: [...renderStatus(ledger, now), ...claimCustody(held, now, shepherd)] }
    } catch (err) {
      return refused(err)
    }
  },
})

/** CC-1151: a dry tick still reads gh and titan-factory through the caller's PATH, so an agent plans instead. */
async function kickTick(dryRun: boolean): Promise<Report> {
  if (dryRun)
    return refused(
      new Error('burndown tick --dry-run refused from an agent shell; use `agent-chat burndown plan`'),
    )
  try {
    return await sendJobKick({ t: 'job_kick', job: 'burndown_tick' })
  } catch (err) {
    return refused(err)
  }
}

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
    if (kicksInBroker()) return kickTick(dryRun === true)
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
  args: pauseByArgs,
  result: Report,
  cli: pauseByCli,
  run: ({ by }) => pauseFromCli(true, by),
})

export const burndownResumeVerb = defineVerb({
  name: 'burndown.resume',
  description: 'let the tick spawn again',
  args: pauseByArgs,
  result: Report,
  cli: pauseByCli,
  run: ({ by }) => pauseFromCli(false, by),
})

export const burndownReleaseVerb = defineVerb({
  name: 'burndown.release',
  description:
    'drop every claim on a task, stalled or not, so the tick may pick it again; --slice drops only that slice',
  args: z.object({ task: requiredString('task'), slice: z.string().min(1).optional() }),
  result: Report,
  cli: {
    positional: ['task'],
    options: {
      slice: {
        long: '--slice',
        description:
          "drop only this slice's claim; the task stays seeded and the slice no longer gates its dependents",
      },
    },
  },
  async run({ task, slice }) {
    // Never autostart: a release that brought up a broker would own it, and the broker serves every session.
    const client = new BrokerClient(() => undefined, undefined, undefined, undefined, undefined, {
      autoStart: false,
    })
    let connected = false
    const retire: RetireCall = async name => {
      if (!connected) {
        await client.connect()
        connected = true
      }
      return tickBroker(client).retire(name)
    }
    try {
      return await releaseTask(task, retire, new Date(), slice)
    } finally {
      client.close()
    }
  },
})

export const burndownLinkVerb = defineVerb({
  name: 'burndown.link',
  description:
    'record a hand-dispatched PR on a queued slice, so the tick never dispatches it and finishes it on merge',
  args: z.object({ task: requiredString('task'), slice: requiredString('slice'), pr: requiredString('pr') }),
  result: Report,
  cli: {
    positional: ['task'],
    options: {
      slice: { long: '--slice', description: 'the queued slice the PR implements' },
      pr: { long: '--pr', description: 'the PR, as owner/repo#n or its URL' },
    },
  },
  run: ({ task, slice, pr }) => linkSlicePr(task, slice, pr),
})

export const burndownUnstallVerb = defineVerb({
  name: 'burndown.unstall',
  description:
    "reload an outside-owns slice's owns from its plan and clear the stall in place, keeping its PR and agents",
  args: z.object({ task: requiredString('task'), slice: requiredString('slice') }),
  result: Report,
  cli: {
    positional: ['task'],
    options: { slice: { long: '--slice', description: 'the stalled slice whose plan owns were fixed' } },
  },
  run: ({ task, slice }) =>
    unstallSlice(task, slice, {
      plan: diskPlanReader(activeWorkRoot()),
      changedFiles: cwd => changedFiles(cwd),
    }),
})

export const burndownBriefApproveVerb = defineVerb({
  name: 'burndown.brief.approve',
  description: "promote a briefer's brief:proposed tag to brief:ready=<today>; refused without a plan file",
  args: z.object({ task: requiredString('task') }),
  result: Report,
  cli: { positional: ['task'] },
  async run({ task }) {
    return approveBrief(task, approvePortsOn(activeWorkRoot()), localDate(new Date()))
  },
})

export { burndownInstall, burndownJobStatus, burndownUninstall } from './burndown-job.js'

export const burndownInstallVerb = defineVerb({
  name: 'burndown.install',
  description:
    'print the sign-off checklist, then install and start the launchd tick job (a systemd --user timer on Linux)',
  args: z.object({ dryRun: z.boolean().optional() }),
  result: Report,
  cli: {
    options: {
      dryRun: {
        long: '--dry-run',
        description: 'print the plist and launchctl calls (units and systemctl calls on Linux); load nothing',
      },
    },
  },
  async run({ dryRun }) {
    return burndownInstallOn(systemHost(dryRun === true))
  },
})

export const burndownUninstallVerb = defineVerb({
  name: 'burndown.uninstall',
  description:
    'stop the launchd tick job and keep it from starting at login; on Linux, also remove its units',
  args: z.object({}),
  result: Report,
  async run() {
    return burndownUninstallOn(systemHost())
  },
})

export const burndownJobStatusVerb = defineVerb({
  name: 'burndown.job-status',
  description:
    'launchd state for the tick job (its systemd units on Linux): loaded, pid, and whether it may spawn',
  args: z.object({}),
  result: Report,
  async run() {
    return burndownJobStatusOn(systemHost())
  },
})

export function addBurndownCommands(program: Commander): void {
  const burndown = program
    .command('burndown')
    .description('pick and run unattended work for opted-in initiatives')
  addVerb(burndown, burndownPlanVerb)
  addVerb(burndown, burndownMilestoneVerb)
  const seats = burndown.command('seats').description('seats mode checks (CC-205)')
  const brief = burndown.command('brief').description('task brief lifecycle (item 179)')
  addVerb(seats, burndownSeatsCompareVerb)
  addVerb(burndown, burndownStatusVerb)
  addVerb(burndown, burndownDispatchStatsVerb)
  addVerb(burndown, burndownTickVerb)
  addVerb(burndown, burndownPauseVerb)
  addVerb(burndown, burndownResumeVerb)
  addVerb(burndown, burndownReleaseVerb)
  addVerb(burndown, burndownLinkVerb)
  addVerb(burndown, burndownUnstallVerb)
  addVerb(burndown, burndownLandedVerb)
  addVerb(brief, burndownBriefApproveVerb)
  addVerb(
    burndown.command('config').description('resolved burndown settings (CC-955)'),
    burndownConfigShowVerb,
  )
  const preset = burndown.command('preset').description('named burndown settings presets (CC-955)')
  addVerb(preset, burndownPresetApplyVerb)
  addVerb(preset, burndownPresetClearVerb)
  addVerb(preset, burndownPresetListVerb)
  const override = burndown.command('override').description('a time-boxed patch over the settings (CC-955)')
  addVerb(override, burndownOverrideSetVerb)
  addVerb(override, burndownOverrideClearVerb)
  const seat = burndown.command('seat').description('turn a seat on or off in the settings (CC-955)')
  addVerb(seat, burndownSeatOnVerb)
  addVerb(seat, burndownSeatOffVerb)
  addVerb(burndown, burndownInstallVerb)
  addVerb(burndown, burndownUninstallVerb)
  addVerb(burndown, burndownJobStatusVerb)
}
