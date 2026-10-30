import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { promisify } from 'node:util'
import path from 'node:path'
import type { Command as Commander } from 'commander'
import { z } from 'zod'
import { requiredString } from '../../args.js'
import { gitChildEnv } from '../../git.js'
import { activeWorkRoot } from '../../agents/active-work.js'
import { readAccountBudget, readBudget } from '../../agents/budget.js'
import { hostIdentity } from '../../server/host.js'
import {
  countLiveHeadless,
  cpuPressurePercent,
  machineStatus,
  readCpuPressure,
  readLoad5,
  readMemoryFree,
  readMemoryPressure,
  readPressureLevel,
  readSwapUsage,
  swapPercent,
  type MachineStatus,
} from '../../agents/machine-guard.js'
import { readHostHeadroom } from '../../agents/host-headroom.js'
import {
  resolveMachineLimits,
  resolveMachineStopLimits,
  resolvePoolPickMode,
  resolvePoolProbe,
} from '../../config.js'
import { readPoolPick } from '../../agents/seats/pool-route.js'
import { readSeatSpawn } from '../../agents/seats/spawn-gate-read.js'
import { machineStop, type MachineStop, type MachineStopReadings } from '../../agents/seats/stops.js'
import { slotUsage } from '../../suite-slots.js'
import { EventLog } from '../../broker/event-log.js'
import { seatBlockReport, type OpenBlock } from '../../seat-blocks.js'
import { suiteSlotDeps } from '../suite-slot.js'
import type { AgentIdentity } from '../../protocol.js'
import { scoredPlanFromDisk, scoredSeatFromDisk } from '../../agents/burndown/score-render.js'
import { renderPlan, seatPlanFromDisk, type SeatPlanOptions } from '../../agents/burndown/tick.js'
import { localDate, readSeatScope } from '../../agents/burndown/seat-tick.js'
import { loadResolvedConfig } from '../../agents/burndown/settings-store.js'
import { renderBoot, seatBoot, type BootDeps } from '../../agents/seats/boot.js'
import {
  charterSeats,
  isSeatName,
  parsePools,
  parseSeat,
  seatSurfaceFor,
} from '../../agents/seats/charter.js'
import { chooseSurface } from '../../agents/surface-resolution.js'
import { brokerHost } from '../../broker/host-guard.js'
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
import { readWaitingPermission } from '../../agents/seats/waiting-permission.js'
import type { OwnerMessage } from '../../agents/seats/stops.js'
import { FIRE_CAP } from '../../agents/seats/watchdog.js'
import { BrokerClient } from '../../client/broker-client.js'
import { systemHost } from '../../mirror/job-host.js'
import { hostLeaseRefusal } from '../../host-lease.js'
import { burndownLedgerPath, home } from '../../paths.js'
import { ledgerImplementers, readLedger } from '../../agents/burndown/ledger.js'
import { claimsPort, eventsVerdictsPort, shepherdPort } from '../../agents/seats/in-flight-read.js'
import { SURFACE_NAMES, type ServerMessage, type SurfaceName } from '../../protocol.js'
import { addVerb, defineVerb, Report } from '../command.js'
import { seatPlanOptions } from './burndown.js'
import { watchdogInstallOn, watchdogStatusOn, watchdogUninstallOn } from './watchdog-job.js'
import {
  notifyAsWatchdog,
  retireStale,
  sendAsOwner,
  sendAsWatchdog,
  withRunningBroker,
  type Reply,
} from './seat-broker.js'
import { kicksInBroker, refusedKickFlags, sendJobKick, type JobKickFrame } from './job-kick.js'
import { buildRelaunchHandoff } from '../../agents/seats/relaunch-handoff.js'
import { identityTranscript } from '../../agents/resume-session.js'
import { respawnSeat } from './seat-respawn.js'
import { seatsCoordinatorsVerb } from './seats-coordinators.js'
import { seatsWatchVerb } from './seats-watch.js'
import { refreshSeatHeartbeat, seatsHeartbeatGapsVerb, seatsHeartbeatInstallVerb } from './seats-heartbeat.js'
import { checkHeartbeat } from '../../agents/seats/heartbeat-check.js'
import { logEvent } from '../../broker/log.js'

const refused = (err: unknown): Report => ({
  ok: false,
  lines: [],
  errors: [err instanceof Error ? err.message : String(err)],
})

/** `seen` keeps each identity by id, so the pass can look up a stuck successor's transcript. */
async function roster(client: BrokerClient, seen: Map<string, AgentIdentity>): Promise<Roster> {
  try {
    const agents = (await client.request({ t: 'agents' }, 'agents_result')) as Reply<'agents_result'>
    const live = (await client.request({ t: 'list' }, 'list_result')) as Reply<'list_result'>
    for (const agent of agents.agents) seen.set(agent.agentId, agent)
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

/**
 * CC-465: owner answer to the CC-437 plan's question 1, any visible launch failure falls back to headless.
 * A refusal before the launch (slots, ownership, a live agent) would refuse headless too, so it stands.
 */
const launchFailed = (res: Reply<'spawn_result'>): boolean =>
  res.code === 'surface_refused' || (res.reason ?? '').startsWith('resume failed:')

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
    launchedBy: 'seat-watchdog' as const,
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

/** The visible resume's result, or the launch failure that sends it headless; a thrown request is one too. */
async function tryVisible(
  client: BrokerClient,
  seat: string,
  message: string,
  declared: DeclaredSurface,
): Promise<WakeResult | { failed: string }> {
  try {
    const visible = await resumeVisible(client, seat, message, declared)
    if (!('t' in visible)) return visible
    const reason = visible.reason ?? 'resume refused'
    return launchFailed(visible) ? { failed: reason } : { ok: false, detail: reason }
  } catch (err) {
    return { failed: err instanceof Error ? err.message : String(err) }
  }
}

/** CC-441, CC-465: a stopped seat resumes on its declared surface, and headless when that launch fails. */
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
    const visible = await tryVisible(client, seat, message, declared)
    if (!('failed' in visible)) return visible
    why = `${declared.surface} refused: ${visible.failed}`
  }
  const res = await resumeOn(client, seat, 'headless', message)
  return res.ok
    ? { ok: true, detail: `resumed headless (${why})` }
    : { ok: false, detail: res.reason ?? 'resume refused' }
}

/**
 * CC-951: the watchdog resumes by teleport's rule, `chooseSurface`, so a mac-only seat surface
 * lands a linux broker in tmux rather than in a refusal and a headless fallback. The seat file
 * wins over the agent record, which takes whatever surface the last resume used, headless included.
 */
export function resumeSurface(
  seatFile: string | undefined,
  recorded: SurfaceName | undefined,
  machine: string,
  platform: NodeJS.Platform,
): DeclaredSurface {
  const fromFile = seatSurfaceFor(seatFile, machine)
  const named = fromFile === undefined ? recorded : undefined
  if (fromFile === undefined && named === undefined) return UNDECLARED
  const choice = chooseSurface({ seatSurface: fromFile, recorded: named, platform })
  // With nothing requested, chooseSurface always picks.
  if (!choice.ok) return UNDECLARED
  const source = fromFile === undefined ? 'agent record' : 'seat file'
  if (choice.from !== 'platform') return { surface: choice.surface, from: source }
  return {
    surface: choice.surface,
    from: `${platform} default; ${source} ${fromFile ?? named} cannot run here`,
  }
}

async function recordedSurface(client: BrokerClient, seat: string): Promise<SurfaceName | undefined> {
  const agents = (await client.request({ t: 'agents' }, 'agents_result')) as Reply<'agents_result'>
  return SURFACE_NAMES.find(name => name === agents.agents.find(a => a.name === seat)?.surface)
}

/** The watchdog runs on the broker's host, so that host's seat entry and OS decide. */
async function declaredSurface(client: BrokerClient, root: string, seat: string): Promise<DeclaredSurface> {
  const seatFile = readText(path.join(root, 'seats', `${seat}.md`))
  const machine = brokerHost()
  const recorded =
    seatSurfaceFor(seatFile, machine) === undefined ? await recordedSurface(client, seat) : undefined
  return resumeSurface(seatFile, recorded, machine, process.platform)
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

/** CC-1057: undefined when events.db cannot be read, so the pass pages nothing and keeps its dedupe. */
function readOpenBlocks(nowMs: number): OpenBlock[] | undefined {
  let log: EventLog | undefined
  try {
    log = new EventLog()
    return seatBlockReport(log, nowMs, nowMs).open
  } catch {
    return undefined
  } finally {
    log?.close()
  }
}

function liveDeps(root: string, client: BrokerClient): WatchdogDeps {
  const identities = new Map<string, AgentIdentity>()
  return {
    now: () => new Date(),
    readCharter: () => readText(path.join(root, 'charter.md')),
    readSeatFile: seat => readText(path.join(root, 'seats', `${seat}.md`)),
    seatLogDays: seat => seatJournalDays(root, seat),
    readSeatLog: (seat, at) => readSeatJournal(root, seat, at),
    readBudget: (dir, nowMs) => readAccountBudget(dir, nowMs),
    ownerMessages: (owner, sinceMs) => ownerMessages(owner, sinceMs),
    machineStop: () => readMachineStop()?.reason,
    roster: () => roster(client, identities),
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
    refreshHeartbeat: seat => refreshSeatHeartbeat(root, seat),
    logEvent,
    relaunchHandoff: (seat, quietMinutes, now) => buildRelaunchHandoff(root, seat, quietMinutes, now),
    transcriptFound: agentId => {
      const identity = identities.get(agentId)
      return identity === undefined ? undefined : identityTranscript(identity).found
    },
    notifyHuman: notifyAsWatchdog,
    relaunchSeat: async (seat, plan) =>
      respawnSeat(client, seat, plan, await declaredSurface(client, root, seat)),
    openBlocks: readOpenBlocks,
    page: sendAsWatchdog,
    seatState: seat => readLedger(burndownLedgerPath()).seats?.[seat],
    retireStale: () => retireStale(client),
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

async function kickJob(frame: JobKickFrame, flags: Record<string, unknown>): Promise<Report> {
  const flagRefusal = refusedKickFlags(frame.job, flags)
  if (flagRefusal !== undefined) return flagRefusal
  try {
    return await sendJobKick(frame)
  } catch (err) {
    return refused(err)
  }
}

export const seatsWatchdogVerb = defineVerb({
  name: 'seats.watchdog',
  description:
    'wake an autonomy seat idle with budget and eligible work (CC-203), and resume a seat that went ' +
    'dark with no teleport (CC-320); silent otherwise. Never wakes or resumes a seat named in the ' +
    '`stopped` map of $AGENT_CHAT_HOME/seat-watchdog.json ({"stopped": {"<seat>": "<reason>"}}; ' +
    'delete the entry to re-enable), a seat at its spend stop, or any seat while the owner seat has ' +
    'announced a broker restart without "restart done". A latest journal line starting WRAP, PARKED ' +
    'or BUDGET-PAUSE stops both the wake and the resume until the seat logs an ordinary line. Pages ' +
    'tp-operator once per live seat blocked on AskUserQuestion over 5 min (CC-1057). An ' +
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
    if (kicksInBroker() && dryRun !== true && day === undefined)
      return kickJob(
        { t: 'job_kick', job: 'seats_watchdog' },
        { '--root': root, '--seat': seat, '--fire-cap': fireCap },
      )
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

export const seatsHeartbeatCheckVerb = defineVerb({
  name: 'seats.heartbeat-check',
  description:
    "what a seat's heartbeat timer runs (CC-947): when the watchdog would neither hold the seat nor " +
    'resume it (connected, no owner stop, restart window, machine stop or stop line) and its logs have ' +
    "no tick line for its cron's widest gap plus 5 min, send the charter heartbeat through the broker " +
    'and log heartbeat_external',
  args: z.object({
    seat: requiredString('seat'),
    root: z.string().optional(),
    dryRun: z.boolean().optional(),
  }),
  result: Report,
  cli: {
    options: {
      seat: { long: '--seat', description: 'the seat to check (required)' },
      root: { long: '--root', description: 'autonomy directory holding charter.md, seats/ and logs/' },
      dryRun: { long: '--dry-run', description: 'print the decision; send nothing' },
    },
  },
  async run({ seat, root, dryRun }) {
    if (!isSeatName(seat)) return refused(new Error(`not a seat name: ${seat}`))
    if (kicksInBroker() && dryRun !== true)
      return kickJob({ t: 'job_kick', job: 'seats_heartbeat_check', seat }, { '--root': root })
    const offLease = hostLeaseRefusal()
    if (offLease !== undefined) return refused(new Error(offLease))
    const dir = root ?? defaultAutonomyRoot()
    try {
      const result = await withRunningBroker(client =>
        checkHeartbeat(
          {
            watchdog: liveDeps(dir, client),
            send: (name, message) => sendAsOwner(client, name, message),
            logEvent,
          },
          seat,
          dryRun === true,
        ),
      )
      return { ok: result.ok, lines: [result.line] }
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
    ledgerImplementers: seat => ledgerImplementers(readLedger(burndownLedgerPath()), seat),
    seatSamples: seat => readLedger(burndownLedgerPath()).seats?.[seat],
    waitingPermission: nowMs => readWaitingPermission(path.join(home(), 'events.db'), nowMs),
    contextOf: agent => readBudget(agent.sessionId, Date.now(), agent.configDir, agent.cwd),
    selfContext: () => {
      const { sessionId } = hostIdentity()
      return sessionId === undefined ? null : readBudget(sessionId)
    },
    nextSpawn: {
      mode: resolvePoolPickMode(),
      pick: spawn => readPoolPick(root, spawn),
      gate: spawn => readSeatSpawn(root, spawn),
    },
  }
}

/** The live memory, swap, pressure level, CPU pressure and load readings the machine stop decides on. */
export const readMachineStopReadings = (): MachineStopReadings => ({
  memoryFreePercent: readMemoryPressure(),
  load5: readLoad5(),
  swapUsedPercent: swapPercent(readSwapUsage()),
  pressureLevel: readPressureLevel(),
  cpuPressurePercent: cpuPressurePercent(readCpuPressure()),
})

/** CC-431, CC-492: the live memory, swap, pressure level and load readings against the stop limits. */
export function readMachineStop(
  readings: MachineStopReadings = readMachineStopReadings(),
): MachineStop | null {
  return machineStop(readings, resolveMachineStopLimits())
}

/** CC-406: the live readings the spawn guard decides on, for the `machine` block. */
function readMachineStatus(agents: AgentIdentity[]): MachineStatus {
  const readings = {
    liveHeadless: countLiveHeadless(agents),
    memory: readMemoryFree(),
    cpuPressure: readCpuPressure(),
    swap: readSwapUsage(),
    headroom: readHostHeadroom(),
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

/** `05:17 tick` or `05:1x SWARM`: a hand-typed clock the verb would double up (CC-1058). */
const LEADING_CLOCK = /^\s*\d{1,2}:[0-5x\d]{1,2}\b/i

const isSeatDir = (root: string, seat: string): boolean =>
  fs.existsSync(path.join(root, 'seats', `${seat}.md`)) || fs.existsSync(path.join(root, 'logs', seat))

function seatLogRefusal(root: string, seat: string, text: string): string | undefined {
  if (!isSeatName(seat)) return `not a seat name: ${seat}`
  if (!isSeatDir(root, seat)) return `no seat '${seat}' under ${root}`
  if (text.trim() === '') return 'the entry is empty: usage: agent-chat seats log <seat> <text...>'
  if (/[\r\n]/.test(text)) return 'one line per entry: the text holds a line break'
  if (LEADING_CLOCK.test(text)) return 'drop the hand-typed time; the verb stamps it'
  return undefined
}

/** CC-1058: the log verb's body; the stamp comes from `now`, never from the text. */
export function seatLogReport(root: string, seat: string, words: string[], now: Date): Report {
  const text = words.join(' ')
  const refusal = seatLogRefusal(root, seat, text)
  if (refusal !== undefined) return refused(new Error(refusal))
  try {
    return { ok: true, lines: [appendSeatLog(root, seat, now, text)] }
  } catch (err) {
    return refused(err)
  }
}

export const seatsLogVerb = defineVerb({
  name: 'seats.log',
  description:
    "append one line to a seat's journal (CC-1058): '<HH:MM> <text>' in " +
    '<root>/logs/<seat>/<YYYY-MM-DD>.md, stamped from the machine clock in local time, and print the ' +
    'file. Refuses and writes nothing on an unknown seat, a line break in the text, or text that opens ' +
    "with a time ('10:00 standup moved' becomes 'standup moved to 10:00')",
  args: z.object({
    seat: requiredString('seat'),
    text: z.array(z.string()),
    root: z.string().optional(),
  }),
  result: Report,
  cli: {
    positional: ['seat', 'text'],
    options: {
      root: { long: '--root', description: 'autonomy directory holding seats/ and logs/' },
    },
  },
  async run({ seat, text, root }) {
    return seatLogReport(root ?? defaultAutonomyRoot(), seat, text, new Date())
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

export function runStartDeps(root: string): RunStartDeps {
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
export function bootDeps(root: string): BootDeps {
  return {
    now: () => new Date(),
    autonomyRoot: root,
    homeDir: os.homedir(),
    eventsDb: path.join(home(), 'events.db'),
    status: seat => withRunningBroker(client => seatStatus(statusDeps(root, client), seat)),
    inFlight: {
      roster: () =>
        withRunningBroker(
          async client =>
            ((await client.request({ t: 'agents' }, 'agents_result')) as Reply<'agents_result'>).agents,
        ),
      shepherd: shepherdPort(),
      verdicts: eventsVerdictsPort(path.join(home(), 'events.db')),
      claims: claimsPort(burndownLedgerPath()),
    },
    ready: async (seat, now) => {
      const opts = { seat, top: Infinity, today: localDate(now), autonomyRoot: root, readySet: true }
      const { plan, tasks, policy } = scoredSeatFromDisk({ ...opts, activeWorkRoot: activeWorkRoot() })
      const { briefMaxAgeDays, scopeTagAliases } = loadResolvedConfig().tick
      const { scope } = readSeatScope(policy.seats, seat, root, scopeTagAliases)
      return { order: plan.order, tasks, scope, maxAgeDays: briefMaxAgeDays }
    },
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
    return {
      ok: true,
      lines: json ? [JSON.stringify(boot, null, 2)] : renderBoot(boot, undefined, deps.homeDir),
    }
  } catch (err) {
    return statusFailure(seat, json, plainError(err, [deps.autonomyRoot, deps.homeDir]))
  }
}

export const seatsBootVerb = defineVerb({
  name: 'seats.boot',
  description:
    "one boot digest for a coordinator seat (CC-318), read-only: the seat file's frontmatter, the " +
    "In flight derived from burndown claims, Shepherd rows, the roster and verdicts, the top in-scope, fresh brief:ready tasks in the gate's ready order with their age, the queue's Next section, the newest State at teleport section of today's log, inbox " +
    'messages after a cutoff and the seat status, in 6,000 characters. Over that the oldest inbox ' +
    'lines go first, then the log section, then the queue, In flight, Next, seat and status sections',
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
  addVerb(seats, seatsLogVerb)
  addVerb(seats, seatsBootVerb)
  addVerb(seats, seatsRunStartVerb)
  addVerb(seats, seatsWatchdogInstallVerb)
  addVerb(seats, seatsWatchdogUninstallVerb)
  addVerb(seats, seatsWatchdogStatusVerb)
  addVerb(seats, seatsHeartbeatInstallVerb)
  addVerb(seats, seatsHeartbeatCheckVerb)
  addVerb(seats, seatsHeartbeatGapsVerb)
  addVerb(seats, seatsCoordinatorsVerb)
  addVerb(seats, seatsWatchVerb)
}
