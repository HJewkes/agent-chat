import { execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'
import path from 'node:path'
import type { Command as Commander } from 'commander'
import { z } from 'zod'
import { requiredString } from '../../args.js'
import { gitChildEnv } from '../../git.js'
import { activeWorkRoot } from '../../agents/active-work.js'
import { readAccountBudget } from '../../agents/budget.js'
import {
  countLiveHeadless,
  machineStatus,
  readLoad5,
  readMemoryFree,
  readMemoryPressure,
  readPressureLevel,
  readSwapUsage,
  swapPercent,
  type MachineStatus,
} from '../../agents/machine-guard.js'
import { resolveMachineLimits, resolveMachineStopLimits, resolvePoolProbe } from '../../config.js'
import { machineStop, type MachineStop } from '../../agents/seats/stops.js'
import { slotUsage } from '../../suite-slots.js'
import { suiteSlotDeps } from '../suite-slot.js'
import type { AgentIdentity } from '../../protocol.js'
import { scoredPlanFromDisk } from '../../agents/burndown/score-render.js'
import { renderPlan, seatPlanFromDisk, type SeatPlanOptions } from '../../agents/burndown/tick.js'
import { renderBoot, seatBoot, type BootDeps } from '../../agents/seats/boot.js'
import { charterSeats, isSeatName, parsePools, parseSeat, seatSurface } from '../../agents/seats/charter.js'
import {
  appendSeatLog,
  defaultAutonomyRoot,
  loadDoc,
  readAgentEvents,
  readDoc,
  readOwnerMessages,
  readPresence,
  readSeatJournal,
  readText,
  saveDoc,
  scorerEligible,
  seatFileNames,
  seatJournalDays,
} from '../../agents/seats/io.js'
import { readDispatches, renderDispatches } from '../../agents/seats/dispatch-read.js'
import { acquireRunLock } from '../../agents/seats/lock.js'
import { diskPaceStore } from '../../agents/seats/pace-pass.js'
import { execServiceCheck } from '../../agents/seats/service-check.js'
import { probePool } from '../../agents/seats/pool-probe.js'
import { renderRunStart, startRun, type RunStartDeps } from '../../agents/seats/run-start.js'
import {
  parseLogReadings,
  parseReadingFlag,
  replay,
  runTimes,
  type ReplayRow,
} from '../../agents/seats/replay.js'
import {
  runWatchdog,
  type Roster,
  type WakeResult,
  type WatchdogDeps,
  type WatchdogOptions,
} from '../../agents/seats/run.js'
import type { Presence } from '../../agents/seats/liveness.js'
import {
  STATUS_TOP,
  plainError,
  readInbox,
  renderBrief,
  renderStatus,
  seatStatus,
  WAITING_OWNER_TAG,
  type StatusDeps,
} from '../../agents/seats/status.js'
import { readPoolPicks } from '../../agents/seats/pool-pick-log.js'
import type { OwnerMessage } from '../../agents/seats/stops.js'
import { FIRE_CAP } from '../../agents/seats/watchdog.js'
import { BrokerClient } from '../../client/broker-client.js'
import { systemHost } from '../../mirror/job-host.js'
import { hostLeaseRefusal } from '../../host-lease.js'
import { home } from '../../paths.js'
import { SURFACE_NAMES, type ServerMessage, type SurfaceName } from '../../protocol.js'
import { addVerb, defineVerb, Report } from '../command.js'
import { seatPlanOptions } from './burndown.js'
import { watchdogInstallOn, watchdogStatusOn, watchdogUninstallOn } from './watchdog-job.js'

type Reply<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

const refused = (err: unknown): Report => ({
  ok: false,
  lines: [],
  errors: [err instanceof Error ? err.message : String(err)],
})

async function roster(client: BrokerClient): Promise<Roster> {
  try {
    const agents = (await client.request({ t: 'agents' }, 'agents_result')) as Reply<'agents_result'>
    const live = (await client.request({ t: 'list' }, 'list_result')) as Reply<'list_result'>
    return { agents: agents.agents, connected: live.sessions.map(s => s.name) }
  } catch (err) {
    // Only a missed reply is unknown; any other failure is a real fault and ends the run.
    if (!(err instanceof Error) || !err.message.startsWith('broker did not answer')) throw err
    return { agents: [], connected: [], unknown: err.message }
  }
}

/** The surface a stopped seat comes back on, and where that was read from. */
export interface DeclaredSurface {
  surface: SurfaceName
  from: string
}

const UNDECLARED: DeclaredSurface = { surface: 'headless', from: 'none declared' }

/** A broker built before `code` existed says it only in `agent-surface`'s refusal text. */
const LEGACY_SURFACE_REFUSED = "use surface 'headless'"

const surfaceRefused = (res: Reply<'spawn_result'>): boolean =>
  res.code === 'surface_refused' || (res.reason ?? '').includes(LEGACY_SURFACE_REFUSED)

async function sendAsOwner(client: BrokerClient, seat: string, message: string): Promise<WakeResult> {
  const res = (await client.request(
    { t: 'human_send', to: seat, text: message, source: 'watchdog' },
    'send_result',
  )) as Reply<'send_result'>
  return res.ok
    ? { ok: true, detail: `message ${res.msgId}` }
    : { ok: false, detail: res.reason ?? 'send refused' }
}

async function resumeOn(
  client: BrokerClient,
  seat: string,
  surface: SurfaceName,
  message?: string,
): Promise<Reply<'spawn_result'>> {
  const frame = {
    t: 'resume' as const,
    name: seat,
    surface,
    ...(message === undefined ? {} : { message }),
    source: 'watchdog' as const,
    // CC-883: a seat runs with Remote Control (10-06 plan D6); the broker drops it for a worker.
    ...(surface === 'headless' ? {} : { remoteControl: true }),
  }
  return (await client.request(frame, 'spawn_result')) as Reply<'spawn_result'>
}

/** A visible resume drops its message, so it goes as a send the broker holds until the seat registers. */
async function resumeVisible(
  client: BrokerClient,
  seat: string,
  message: string,
  declared: DeclaredSurface,
): Promise<WakeResult | Reply<'spawn_result'>> {
  const res = await resumeOn(client, seat, declared.surface)
  if (!res.ok) return res
  const sent = await sendAsOwner(client, seat, message)
  const delivery = sent.ok ? sent.detail : `message not delivered: ${sent.detail}`
  return { ok: true, detail: `resumed on ${declared.surface} (${declared.from}); ${delivery}` }
}

/** CC-441: a stopped seat resumes on its declared surface, and headless only when iTerm refuses it. */
export async function wakeSeat(
  client: BrokerClient,
  seat: string,
  message: string,
  connected: boolean,
  declared: DeclaredSurface = UNDECLARED,
): Promise<WakeResult> {
  if (connected) return sendAsOwner(client, seat, message)
  let why = declared.from
  if (declared.surface !== 'headless') {
    const visible = await resumeVisible(client, seat, message, declared)
    if (!('t' in visible)) return visible
    const reason = visible.reason ?? 'resume refused'
    if (!surfaceRefused(visible)) return { ok: false, detail: reason }
    why = `${declared.surface} refused: ${reason}`
  }
  const res = await resumeOn(client, seat, 'headless', message)
  return res.ok
    ? { ok: true, detail: `resumed headless (${why})` }
    : { ok: false, detail: res.reason ?? 'resume refused' }
}

/** The seat file's `surface:` wins, since the agent record takes whatever surface the last resume used. */
async function declaredSurface(client: BrokerClient, root: string, seat: string): Promise<DeclaredSurface> {
  const fromFile = seatSurface(readText(path.join(root, 'seats', `${seat}.md`)))
  if (fromFile !== undefined) return { surface: fromFile, from: 'seat file' }
  const agents = (await client.request({ t: 'agents' }, 'agents_result')) as Reply<'agents_result'>
  const recorded = SURFACE_NAMES.find(name => name === agents.agents.find(a => a.name === seat)?.surface)
  return recorded === undefined ? UNDECLARED : { surface: recorded, from: 'agent record' }
}

/** Undefined when events.db cannot be read, so the caller holds every seat rather than risk a restart window. */
function ownerMessages(owner: string, sinceMs: number): OwnerMessage[] | undefined {
  try {
    return readOwnerMessages(path.join(home(), 'events.db'), owner, sinceMs)
  } catch {
    return undefined
  }
}

/** Undefined when events.db cannot be read, so the caller resumes nothing on a guess. */
function presence(seat: string): Presence | undefined {
  try {
    return readPresence(path.join(home(), 'events.db'), seat)
  } catch {
    return undefined
  }
}

function liveDeps(root: string, client: BrokerClient): WatchdogDeps {
  return {
    now: () => new Date(),
    readCharter: () => readText(path.join(root, 'charter.md')),
    readSeatFile: seat => readText(path.join(root, 'seats', `${seat}.md`)),
    seatLogDays: seat => seatJournalDays(root, seat),
    readSeatLog: (seat, at) => readSeatJournal(root, seat, at),
    readBudget: (dir, nowMs) => readAccountBudget(dir, nowMs),
    ownerMessages: (owner, sinceMs) => ownerMessages(owner, sinceMs),
    machineStop: () => readMachineStop()?.reason,
    roster: () => roster(client),
    presence,
    eligible: seat => scorerEligible(root, seat),
    loadDoc: () => loadDoc(),
    saveDoc: doc => saveDoc(doc),
    lock: () => acquireRunLock(),
    pace: diskPaceStore(root),
    ...(resolvePoolProbe() ? { probe: (configDir: string) => probePool(configDir) } : {}),
    seatNames: () => seatFileNames(root),
    serviceCheck: execServiceCheck,
    wake: async (seat, message, connected) =>
      wakeSeat(
        client,
        seat,
        message,
        connected,
        connected ? UNDECLARED : await declaredSurface(client, root, seat),
      ),
    appendLog: (seat, at, text) => void appendSeatLog(root, seat, at, text),
  }
}

/** Never autostarts: a seat verb that brought up a broker would own it, and the broker serves every session. */
async function withRunningBroker<T>(fn: (client: BrokerClient) => Promise<T>): Promise<T> {
  const client = new BrokerClient(() => undefined, undefined, undefined, undefined, undefined, {
    autoStart: false,
  })
  try {
    await client.connect()
    return await fn(client)
  } finally {
    client.close()
  }
}

async function liveRun(root: string, options: WatchdogOptions): Promise<Report> {
  const lines = await withRunningBroker(client => runWatchdog(liveDeps(root, client), options))
  return { ok: true, lines }
}

const hhmm = (at: number): string => new Date(at).toISOString().slice(11, 16) + 'Z'

/** Every fire, and every run whose reason differs from the run before, so a quiet day stays short. */
function renderReplay(seat: string, rows: ReplayRow[]): string[] {
  const changed = rows.filter((row, i) => row.fire || row.reason !== rows[i - 1]?.reason)
  const fires = rows.filter(row => row.fire).map(row => hhmm(row.at))
  return [
    `== ${seat}`,
    ...changed.map(
      row => `${hhmm(row.at)} ${row.fire ? 'FIRE' : 'skip'} [${row.implementers.join(', ')}] ${row.reason}`,
    ),
    `fires: ${fires.length === 0 ? 'none' : fires.join(', ')}`,
  ]
}

function replayRun(root: string, day: string, seats: string[] | undefined, flags: string[]): Report {
  const charter = readText(path.join(root, 'charter.md'))
  if (charter === undefined) throw new Error(`no charter.md under ${root}`)
  const times = runTimes(day)
  const events = readAgentEvents(path.join(home(), 'events.db'), (times.at(-1) ?? 0) + 60_000)
  const extra = flags.map(parseReadingFlag)
  const lines: string[] = []
  for (const name of (seats ?? charterSeats(charter)).filter(isSeatName)) {
    const seat = parseSeat(name, readText(path.join(root, 'seats', `${name}.md`)) ?? '')
    if (seat === undefined) continue
    const readings = [
      ...parseLogReadings(readText(path.join(root, 'logs', name, `${day}.md`)) ?? '', day),
      ...extra,
    ]
    const scored = scorerEligible(root, name)
    const eligible = scored?.count
    const skipped = scored === undefined || scored.skipped === 0 ? '' : `, skipped: ${scored.skipped}`
    lines.push(
      `${name}: eligible ${eligible ?? 'unknown'}${skipped} is TODAY's scorer count, assumed for ${day}`,
    )
    const pool = parsePools(charter).get(seat.pool)
    lines.push(...renderReplay(name, replay({ seat, pool, events, readings, eligible }, times)))
  }
  return { ok: true, lines }
}

export const seatsWatchdogVerb = defineVerb({
  name: 'seats.watchdog',
  description:
    'wake an autonomy seat idle with budget and eligible work (CC-203), and resume a seat that went ' +
    'dark with no teleport (CC-320); silent otherwise. Never wakes or resumes a seat named in the ' +
    '`stopped` map of $AGENT_CHAT_HOME/seat-watchdog.json ({"stopped": {"<seat>": "<reason>"}}; ' +
    'delete the entry to re-enable), a seat at its spend stop, or any seat while the owner seat has ' +
    'announced a broker restart without "restart done". A latest journal line starting WRAP, PARKED ' +
    'or BUDGET-PAUSE stops both the wake and the resume until the seat logs an ordinary line. An ' +
    'unparsable seat-watchdog.json is an error and the run does nothing',
  args: z.object({
    dryRun: z.boolean().optional(),
    replay: z.string().optional(),
    seat: z.array(z.string()).optional(),
    reading: z.array(z.string()).optional(),
    root: z.string().optional(),
    fireCap: z.coerce.number().int().positive().optional(),
  }),
  result: Report,
  cli: {
    options: {
      dryRun: { long: '--dry-run', description: 'print each seat decision; wake nothing, write nothing' },
      replay: { long: '--replay', description: 'run a past UTC day (YYYY-MM-DD) from events.db, read-only' },
      seat: { long: '--seat', description: 'only this seat (repeatable); default every seat in the charter' },
      reading: {
        long: '--reading',
        description: 'replay budget reading <ISO>=<five_hour>/<seven_day> (repeatable)',
      },
      root: { long: '--root', description: 'autonomy directory holding charter.md, seats/ and logs/' },
      fireCap: {
        long: '--fire-cap',
        description: `wakes with no implementer before holding until the seat shows activity (default ${FIRE_CAP})`,
      },
    },
  },
  async run({ dryRun, replay: day, seat, reading, root, fireCap }) {
    const offLease = hostLeaseRefusal()
    if (offLease !== undefined) return refused(new Error(offLease))
    const dir = root ?? defaultAutonomyRoot()
    try {
      if (day !== undefined) return replayRun(dir, day, seat, reading ?? [])
      return await liveRun(dir, {
        dryRun: dryRun === true,
        ...(seat === undefined ? {} : { seats: seat }),
        ...(fireCap === undefined ? {} : { fireCap }),
      })
    } catch (err) {
      return refused(err)
    }
  },
})

export { watchdogInstall } from './watchdog-job.js'

const AGENT_CHAT_HOME_FLAG =
  'the home the job runs against, over $AGENT_CHAT_HOME; on Linux a non-default home suffixes the unit names'

export const seatsWatchdogInstallVerb = defineVerb({
  name: 'seats.watchdog-install',
  description:
    'install the launchd job (systemd --user units on Linux) that runs `seats watchdog` four times an hour; ' +
    'the first run waits for the next scheduled minute',
  args: z.object({ dryRun: z.boolean().optional(), agentChatHome: z.string().optional() }),
  result: Report,
  cli: {
    options: {
      dryRun: {
        long: '--dry-run',
        description: 'print the plist and launchctl calls (units and systemctl calls on Linux); load nothing',
      },
      agentChatHome: { long: '--agent-chat-home', description: AGENT_CHAT_HOME_FLAG },
    },
  },
  async run({ dryRun, agentChatHome }) {
    return watchdogInstallOn(systemHost(dryRun === true), { agentChatHome })
  },
})

export const seatsWatchdogUninstallVerb = defineVerb({
  name: 'seats.watchdog-uninstall',
  description: 'stop the watchdog job and keep it from starting at login; on Linux, also remove its units',
  args: z.object({ agentChatHome: z.string().optional() }),
  result: Report,
  cli: { options: { agentChatHome: { long: '--agent-chat-home', description: AGENT_CHAT_HOME_FLAG } } },
  async run({ agentChatHome }) {
    return watchdogUninstallOn(systemHost(), { agentChatHome })
  },
})

export const seatsWatchdogStatusVerb = defineVerb({
  name: 'seats.watchdog-status',
  description: 'launchd state of the watchdog job, or its systemd units on Linux',
  args: z.object({ agentChatHome: z.string().optional() }),
  result: Report,
  cli: { options: { agentChatHome: { long: '--agent-chat-home', description: AGENT_CHAT_HOME_FLAG } } },
  async run({ agentChatHome }) {
    return watchdogStatusOn(systemHost(), { agentChatHome })
  },
})

const execFileAsync = promisify(execFile)

function statusDeps(root: string, client: BrokerClient): StatusDeps {
  return {
    now: () => new Date(),
    autonomyRoot: root,
    homeDir: os.homedir(),
    agents: async () =>
      ((await client.request({ t: 'agents' }, 'agents_result')) as Reply<'agents_result'>).agents,
    waitingOwner: async () => {
      const live = (await client.request({ t: 'list' }, 'list_result')) as Reply<'list_result'>
      return live.sessions.filter(s => s.tags?.some(t => t.tag === WAITING_OWNER_TAG)).map(s => s.name)
    },
    repoTrees: async repo =>
      (
        await execFileAsync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], {
          timeout: 5000,
          encoding: 'utf8',
          env: gitChildEnv(),
        })
      ).stdout,
    readBudget: (dir, nowMs) => readAccountBudget(dir, nowMs),
    loadDoc: () => readDoc(),
    inbox: seat => readInbox(path.join(home(), 'events.db'), seat),
    poolPicks: seat => readPoolPicks(path.join(home(), 'events.db'), seat),
    scored: (seat, today) =>
      scoredPlanFromDisk({
        seat,
        top: STATUS_TOP,
        today,
        autonomyRoot: root,
        activeWorkRoot: activeWorkRoot(),
      }),
    machine: readMachineStatus,
    machineStop: readMachineStop,
  }
}

/** CC-431, CC-492: the live memory, swap, pressure level and load readings against the stop limits. */
function readMachineStop(): MachineStop | null {
  return machineStop(
    {
      memoryFreePercent: readMemoryPressure(),
      load5: readLoad5(),
      swapUsedPercent: swapPercent(readSwapUsage()),
      pressureLevel: readPressureLevel(),
    },
    resolveMachineStopLimits(),
  )
}

/** CC-406: the live readings the spawn guard decides on, for the `machine` block. */
function readMachineStatus(agents: AgentIdentity[]): MachineStatus {
  const readings = {
    liveHeadless: countLiveHeadless(agents),
    memory: readMemoryFree(),
    swap: readSwapUsage(),
  }
  return machineStatus(readings, resolveMachineLimits(), slotUsage(suiteSlotDeps()))
}

/** Under --json a failure is one document on stdout too, so a caller never parses an empty string. */
function statusFailure(seat: string, json: boolean, error: string): Report {
  return json
    ? { ok: false, lines: [JSON.stringify({ seat, error }, null, 2)] }
    : { ok: false, lines: [], errors: [error] }
}

/** The status verb's body, taking its readers explicitly so a test can point them at a fixture broker. */
export async function statusReport(
  deps: StatusDeps,
  seat: string,
  json: boolean,
  brief = false,
): Promise<Report> {
  try {
    const status = await seatStatus(deps, seat)
    const lines = json
      ? [JSON.stringify(status, null, 2)]
      : brief
        ? renderBrief(status)
        : renderStatus(status)
    return { ok: true, lines }
  } catch (err) {
    return statusFailure(seat, json, plainError(err, [deps.autonomyRoot, deps.homeDir]))
  }
}

export const seatsStatusVerb = defineVerb({
  name: 'seats.status',
  description:
    'what a seat reads before it dispatches (CC-317), read-only: implementers, reviewers and planners ' +
    'against their caps, its other running agents, parked implementers, the pool reading with its age ' +
    'and the charter stop that applies, the pace of every pool against its glide path, unread inbox ' +
    'messages since the seat last sent one, the ' +
    'machine-wide headless agents, free memory and full-suite slots against their limits, swap used, and the ' +
    'top eligible tasks. A spend cap with no saved meter to count it is a stop',
  args: z.object({
    seat: requiredString('seat'),
    json: z.boolean().optional(),
    brief: z.boolean().optional(),
    root: z.string().optional(),
  }),
  result: Report,
  cli: {
    positional: ['seat'],
    options: {
      json: {
        long: '--json',
        description: 'the same facts as one JSON object; a failure is {"seat", "error"} with exit 1',
      },
      brief: {
        long: '--brief',
        description: 'only caps per role with names, the pool reading and stop, unread and parked counts',
      },
      root: { long: '--root', description: 'autonomy directory holding charter.md and seats/' },
    },
  },
  async run({ seat, json, brief, root }) {
    if (json === true && brief === true)
      return statusFailure(seat, true, 'seats status takes --brief or --json, not both')
    const dir = root ?? defaultAutonomyRoot()
    try {
      return await withRunningBroker(client =>
        statusReport(statusDeps(dir, client), seat, json === true, brief === true),
      )
    } catch (err) {
      return statusFailure(seat, json === true, plainError(err, [dir, os.homedir()]))
    }
  },
})

/**
 * CC-889: a live tick for one seat is refused. The timer's tick advances every held claim under the
 * ledger lock, and the respawn ladder's first rung spans two ticks, so an extra tick between timer
 * ticks would retire or respawn a stalled agent early, for this seat's claims and every other seat's.
 */
const LIVE_TICK_REFUSAL =
  'seats tick runs only with --dry-run: a live tick off the timer would advance every claim a phase early; ' +
  '`agent-chat burndown tick --once` is the one live tick'

/** The tick verb's body, taking the plan inputs as a loader so a test can point it at a fixture world. */
export async function seatTickReport(dryRun: boolean, load: () => Promise<SeatPlanOptions>): Promise<Report> {
  if (!dryRun) return { ok: false, lines: [], errors: [LIVE_TICK_REFUSAL] }
  try {
    const opts = await load()
    const [, ...decision] = renderPlan(seatPlanFromDisk(opts), opts.now)
    return { ok: true, lines: [`seat ${opts.seat} tick at ${opts.now.toISOString()} (dry run)`, ...decision] }
  } catch (err) {
    return { ok: false, lines: [], errors: [err instanceof Error ? err.message : String(err)] }
  }
}

export const seatsTickVerb = defineVerb({
  name: 'seats.tick',
  description:
    "one seat's burndown decision on demand (CC-889): the dispatches the tick would make for it under " +
    'its service-check stop line, trust gate, role and worktree caps and pool gate, and why every other ' +
    'task was refused. ' +
    'Dry run only: it spawns nothing and writes no ledger',
  args: z.object({
    seat: requiredString('seat'),
    dryRun: z.boolean().optional(),
    root: z.string().optional(),
  }),
  result: Report,
  cli: {
    positional: ['seat'],
    options: {
      dryRun: { long: '--dry-run', description: 'print the decision without spawning (required)' },
      root: { long: '--root', description: 'autonomy directory holding charter.md and seats/' },
    },
  },
  async run({ seat, dryRun, root }) {
    return seatTickReport(dryRun === true, () => seatPlanOptions(seat, root))
  },
})

/** The dispatches verb's body; an unknown seat, a bad `--since` or a missing log is a plain error. */
export function dispatchesReport(
  root: string,
  seat: string,
  since: string | undefined,
  json: boolean,
): Report {
  try {
    return { ok: true, lines: renderDispatches(readDispatches(root, seat, since), json) }
  } catch (err) {
    return statusFailure(seat, json, plainError(err, [root, os.homedir()]))
  }
}

export const seatsDispatchesVerb = defineVerb({
  name: 'seats.dispatches',
  description:
    "one folded record per agent run from a seat's dispatch log (CC-332), read-only: the broker's " +
    "spawn and retire rows and the seat's own rows merged, with the spend. Lines that are not a JSON " +
    'object with an agent and seat outcomes outside the end states are counted, not fatal',
  args: z.object({
    seat: requiredString('seat'),
    since: z.string().optional(),
    json: z.boolean().optional(),
    root: z.string().optional(),
  }),
  result: Report,
  cli: {
    positional: ['seat'],
    options: {
      since: {
        long: '--since',
        description: 'only runs dispatched at or after this time (YYYY-MM-DD or ISO; no zone means UTC)',
      },
      json: {
        long: '--json',
        description:
          'one JSON record per line, then {"malformed","invalid_outcomes"}; a failure is {"seat", "error"}',
      },
      root: { long: '--root', description: 'autonomy directory holding charter.md, seats/ and logs/' },
    },
  },
  async run({ seat, since, json, root }) {
    return dispatchesReport(root ?? defaultAutonomyRoot(), seat, since, json === true)
  },
})

function runStartDeps(root: string): RunStartDeps {
  return {
    now: () => new Date(),
    readCharter: () => readText(path.join(root, 'charter.md')),
    readSeatFile: seat => readText(path.join(root, 'seats', `${seat}.md`)),
    readBudget: (dir, nowMs) => readAccountBudget(dir, nowMs),
    loadDoc: () => loadDoc(),
    saveDoc: doc => saveDoc(doc),
    lock: () => acquireRunLock(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  }
}

/** The run-start verb's body, taking its readers explicitly so a test can point them at a fixture home. */
export async function runStartReport(deps: RunStartDeps, seat: string): Promise<Report> {
  try {
    return { ok: true, lines: renderRunStart(await startRun(deps, seat)) }
  } catch (err) {
    return refused(err)
  }
}

export const seatsRunStartVerb = defineVerb({
  name: 'seats.run-start',
  description:
    "start a new run for a seat when the owner messages it (CC-472): sets the seat's run meter in " +
    '$AGENT_CHAT_HOME/seat-watchdog.json to {since: now, last: <pool seven_day now>, spent: 0, ' +
    'before: <old last>} under the watchdog run lock, leaving every other entry as it was. Refuses and ' +
    'writes nothing on unknown_seat, no_reading (no seven_day reading, or one over 15 min old) or ' +
    'lock_held (a watchdog run held the lock for 90 s)',
  args: z.object({ seat: requiredString('seat'), root: z.string().optional() }),
  result: Report,
  cli: {
    positional: ['seat'],
    options: {
      root: { long: '--root', description: 'autonomy directory holding charter.md and seats/' },
    },
  },
  async run({ seat, root }) {
    return runStartReport(runStartDeps(root ?? defaultAutonomyRoot()), seat)
  },
})

/** The status opens its own broker connection, so a broker that is down costs the boot only its status. */
function bootDeps(root: string): BootDeps {
  return {
    now: () => new Date(),
    autonomyRoot: root,
    homeDir: os.homedir(),
    eventsDb: path.join(home(), 'events.db'),
    status: seat => withRunningBroker(client => seatStatus(statusDeps(root, client), seat)),
  }
}

/** The boot verb's body, taking its readers explicitly so a test can point them at a fixture root. */
export async function bootReport(
  deps: BootDeps,
  seat: string,
  after: string | undefined,
  json: boolean,
): Promise<Report> {
  try {
    const boot = await seatBoot(deps, seat, after)
    return { ok: true, lines: json ? [JSON.stringify(boot, null, 2)] : renderBoot(boot) }
  } catch (err) {
    return statusFailure(seat, json, plainError(err, [deps.autonomyRoot, deps.homeDir]))
  }
}

export const seatsBootVerb = defineVerb({
  name: 'seats.boot',
  description:
    "one boot digest for a coordinator seat (CC-318), read-only: the seat file's frontmatter, the " +
    "queue's In flight and Next sections, the newest State at teleport section of today's log, inbox " +
    'messages after a cutoff and the seat status, in 6,000 characters. Over that the oldest inbox ' +
    'lines go first, then the log section; the queue and status are never cut',
  args: z.object({
    seat: requiredString('seat'),
    after: z.string().optional(),
    json: z.boolean().optional(),
    root: z.string().optional(),
  }),
  result: Report,
  cli: {
    positional: ['seat'],
    options: {
      after: {
        long: '--after',
        description:
          "show inbox messages after this msg_id; default the State block's own cursor, else the last 5",
      },
      json: {
        long: '--json',
        description:
          'the sections without the 6,000-character cut, as one JSON object; a failure is {"seat", "error"} with exit 1',
      },
      root: {
        long: '--root',
        description: 'autonomy directory holding charter.md, seats/, queues/ and logs/',
      },
    },
  },
  async run({ seat, after, json, root }) {
    return bootReport(bootDeps(root ?? defaultAutonomyRoot()), seat, after, json === true)
  },
})

export function addSeatsCommands(program: Commander): void {
  const seats = program.command('seats').description('autonomy seats: the idle watchdog')
  addVerb(seats, seatsWatchdogVerb)
  addVerb(seats, seatsStatusVerb)
  addVerb(seats, seatsTickVerb)
  addVerb(seats, seatsDispatchesVerb)
  addVerb(seats, seatsBootVerb)
  addVerb(seats, seatsRunStartVerb)
  addVerb(seats, seatsWatchdogInstallVerb)
  addVerb(seats, seatsWatchdogUninstallVerb)
  addVerb(seats, seatsWatchdogStatusVerb)
}
