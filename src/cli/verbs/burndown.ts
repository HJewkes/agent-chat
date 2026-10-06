import fs from 'node:fs'
import os from 'node:os'
import type { Command as Commander } from 'commander'
import { z } from 'zod'
import { requiredString } from '../../args.js'
import {
  BURNDOWN_LABEL,
  burndownConfigPath,
  burndownLedgerPath,
  burndownLogDir,
  burndownPausePath,
  burndownPlistPath,
  cliEntry,
} from '../../paths.js'
import { activeWorkRoot } from '../../agents/active-work.js'
import { defaultAutonomyRoot } from '../../agents/burndown/policy.js'
import { renderScored, scoredPlanFromDisk } from '../../agents/burndown/score-render.js'
import { renderMilestoneLine } from '../../agents/burndown/milestone-report.js'
import { milestoneReportFromDisk, type MilestoneReportRead } from '../../agents/burndown/milestone-source.js'
import { localDate } from '../../agents/burndown/seat-tick.js'
import { collisionCheck, type BrokerView } from '../../agents/burndown/collision.js'
import { readLedger, withLedgerLock, writeLedger } from '../../agents/burndown/ledger.js'
import { loadTickConfig } from '../../agents/burndown/source.js'
import { tickFromDisk } from '../../agents/burndown/run-tick.js'
import { TICK_INTERVAL_SECONDS } from '../../agents/burndown/tick-status.js'
import { seatCompareFromDisk } from '../../agents/burndown/seat-compare.js'
import {
  planFromDisk,
  renderPlan,
  renderStatus,
  seatPlanFromDisk,
  type SeatPlanOptions,
} from '../../agents/burndown/tick.js'
import { BrokerClient } from '../../client/broker-client.js'
import { jobState, startJob, stopJob, systemLaunchctl, type JobControl } from '../../mirror/launchd.js'
import { jobEnv, launchdJobRefusals, renderBurndownPlist } from '../../mirror/plist.js'
import { addVerb, defineVerb, Report } from '../command.js'
import { collisionView, tickBroker } from '../burndown-broker.js'
import { releaseTask, type RetireCall } from './burndown-release.js'

/** Production control; every verb below takes one as a parameter so tests can inject a stub. */
const defaultControl = (dryRun = false): JobControl => ({
  launchctl: systemLaunchctl,
  uid: process.getuid?.() ?? 0,
  dryRun,
  label: BURNDOWN_LABEL,
})

/** Section 7 of the slice-4 plan: every item a human checks before the tick may spawn unattended. */
const SIGN_OFF_CHECKLIST = [
  "Sign-off checklist (CC-slice4-plan.md section 7) — every item is yours to check, not the tick's:",
  '[ ] Settings allowlist covers git fetch/merge --ff-only/add/commit, git push -u origin agent-chat/*,' +
    ' npm run format(:check)/typecheck/build, npx vitest run, gh pr create/view/checks (not gh pr merge).',
  '[ ] Decider deployed in a restart window, or explicitly waived.',
  '[ ] Lean bd-* profiles live after a broker restart; R3 bootstrap measurement read.',
  '[ ] Slot ceiling: burndown.config.json maxAgents set and below free broker slots.',
  '[ ] Worktree ceiling: maxWorktreesPerRepo and reserveWorktrees set per opted-in repo; orphans reclaimed.',
  '[ ] Trust: burndown plan shows no trust refusal; the installed CLI is still the pinned version.',
  '[ ] Budget: burndown.config.json reserves reviewed; billing account(s) confirmed.',
  '[ ] reportTo set to a registered session in burndown.config.json (a real tick refuses without it).',
  '[ ] Opt-in scope: exactly one initiative, lanes: 1, grants: [].',
  '[ ] Three supervised `burndown tick --once` runs done by hand; `burndown status` read after each.',
  '[ ] Seats mode: per listed seat, three dry runs each followed by `burndown seats compare`, all exiting 0.',
  '[ ] Seats mode: each listed seat no longer dispatches scored work itself; no brief has an autonomy: block.',
  '[ ] Kill switch known: `burndown pause` stops new spawns; `burndown uninstall` removes the job.',
]

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
async function seatPlanOptions(seat: string, autonomyRoot: string | undefined): Promise<SeatPlanOptions> {
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
      return await releaseTask(task, retire)
    } finally {
      client.close()
    }
  },
})

/** The install verb's body, taking its `JobControl` explicitly so a test can inject a stub. */
export function burndownInstall(dryRun: boolean, control: JobControl): Report {
  const lines = [...SIGN_OFF_CHECKLIST]
  if (!loadTickConfig(burndownConfigPath()).enabled) {
    return { ok: false, lines, errors: ['refused: burndown.config.json has enabled: false'] }
  }
  const job = { nodePath: process.execPath, cliEntry: cliEntry(), env: jobEnv(process.env) }
  const errors = launchdJobRefusals({ ...job, tmpdir: os.tmpdir() })
  if (errors.length > 0) return { ok: false, lines, errors }
  const plist = renderBurndownPlist({
    ...job,
    label: BURNDOWN_LABEL,
    logDir: burndownLogDir(),
    intervalSeconds: TICK_INTERVAL_SECONDS,
  })
  const paths = { plist: burndownPlistPath(), logDir: burndownLogDir() }
  const result = startJob(paths, plist, control)
  return dryRun
    ? { ok: true, lines: [...lines, plist, ...result.lines] }
    : { ...result, lines: [...lines, ...result.lines] }
}

export const burndownInstallVerb = defineVerb({
  name: 'burndown.install',
  description: 'print the sign-off checklist, then install and start the launchd tick job',
  args: z.object({ dryRun: z.boolean().optional() }),
  result: Report,
  cli: {
    options: {
      dryRun: { long: '--dry-run', description: 'print the plist and launchctl calls; load nothing' },
    },
  },
  async run({ dryRun }) {
    return burndownInstall(dryRun === true, defaultControl(dryRun === true))
  },
})

/** The uninstall verb's body, taking its `JobControl` explicitly so a test can inject a stub. */
export function burndownUninstall(control: JobControl): Report {
  return stopJob(control)
}

export const burndownUninstallVerb = defineVerb({
  name: 'burndown.uninstall',
  description: 'stop the launchd tick job and keep it from starting at login',
  args: z.object({}),
  result: Report,
  async run() {
    return burndownUninstall(defaultControl())
  },
})

/** The job-status verb's body, taking its `JobControl` explicitly so a test can inject a stub. */
export function burndownJobStatus(control: JobControl): Report {
  const job = jobState(control)
  const config = loadTickConfig(burndownConfigPath())
  const launchd = job.loaded
    ? `loaded${job.pid === null ? ', not running' : `, pid ${job.pid}`}`
    : 'not loaded'
  return {
    ok: true,
    lines: [
      `launchd ${launchd}`,
      `plist ${burndownPlistPath()}`,
      `config enabled=${config.enabled} paused=${fs.existsSync(burndownPausePath())}`,
    ],
  }
}

export const burndownJobStatusVerb = defineVerb({
  name: 'burndown.job-status',
  description: 'launchd state for the tick job: loaded, pid, and whether it may spawn',
  args: z.object({}),
  result: Report,
  async run() {
    return burndownJobStatus(defaultControl())
  },
})

export function addBurndownCommands(program: Commander): void {
  const burndown = program
    .command('burndown')
    .description('pick and run unattended work for opted-in initiatives')
  addVerb(burndown, burndownPlanVerb)
  addVerb(burndown, burndownMilestoneVerb)
  const seats = burndown.command('seats').description('seats mode checks (CC-205)')
  addVerb(seats, burndownSeatsCompareVerb)
  addVerb(burndown, burndownStatusVerb)
  addVerb(burndown, burndownTickVerb)
  addVerb(burndown, burndownPauseVerb)
  addVerb(burndown, burndownResumeVerb)
  addVerb(burndown, burndownReleaseVerb)
  addVerb(burndown, burndownInstallVerb)
  addVerb(burndown, burndownUninstallVerb)
  addVerb(burndown, burndownJobStatusVerb)
}
