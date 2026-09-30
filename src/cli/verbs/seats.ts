import path from 'node:path'
import type { Command as Commander } from 'commander'
import { z } from 'zod'
import { readAccountBudget } from '../../agents/budget.js'
import { charterSeats, isSeatName, parsePools, parseSeat } from '../../agents/seats/charter.js'
import {
  appendSeatLog,
  defaultAutonomyRoot,
  loadDoc,
  readAgentEvents,
  readOwnerMessages,
  readPresence,
  readText,
  saveDoc,
  scorerEligible,
  seatLogPath,
} from '../../agents/seats/io.js'
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
import type { OwnerMessage } from '../../agents/seats/stops.js'
import { FIRE_CAP, WATCHDOG_MINUTES } from '../../agents/seats/watchdog.js'
import { BrokerClient } from '../../client/broker-client.js'
import { startJob, systemLaunchctl, type JobControl } from '../../mirror/launchd.js'
import { jobEnv, renderWatchdogPlist } from '../../mirror/plist.js'
import { WATCHDOG_LABEL, cliEntry, home, watchdogLogDir, watchdogPlistPath } from '../../paths.js'
import type { ServerMessage } from '../../protocol.js'
import { addVerb, defineVerb, Report } from '../command.js'

type Reply<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

const refused = (err: unknown): Report => ({
  ok: false,
  lines: [],
  errors: [err instanceof Error ? err.message : String(err)],
})

async function roster(client: BrokerClient): Promise<Roster> {
  const agents = (await client.request({ t: 'agents' }, 'agents_result')) as Reply<'agents_result'>
  const live = (await client.request({ t: 'list' }, 'list_result')) as Reply<'list_result'>
  return { agents: agents.agents, connected: live.sessions.map(s => s.name) }
}

/** A connected seat cannot be resumed, so it gets the message as the owner's job would type it. */
export async function wakeSeat(
  client: BrokerClient,
  seat: string,
  message: string,
  connected: boolean,
): Promise<WakeResult> {
  if (connected) {
    const res = (await client.request(
      { t: 'human_send', to: seat, text: message, source: 'watchdog' },
      'send_result',
    )) as Reply<'send_result'>
    return res.ok
      ? { ok: true, detail: `message ${res.msgId}` }
      : { ok: false, detail: res.reason ?? 'send refused' }
  }
  const frame = {
    t: 'resume' as const,
    name: seat,
    surface: 'headless' as const,
    message,
    source: 'watchdog' as const,
  }
  const res = (await client.request(frame, 'spawn_result')) as Reply<'spawn_result'>
  return res.ok ? { ok: true, detail: 'resumed' } : { ok: false, detail: res.reason ?? 'resume refused' }
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
    readSeatLog: (seat, at) => readText(seatLogPath(root, seat, at)),
    readBudget: (dir, nowMs) => readAccountBudget(dir, nowMs),
    ownerMessages: (owner, sinceMs) => ownerMessages(owner, sinceMs),
    roster: () => roster(client),
    presence,
    eligible: seat => scorerEligible(root, seat),
    loadDoc: () => loadDoc(),
    saveDoc: doc => saveDoc(doc),
    wake: (seat, message, connected) => wakeSeat(client, seat, message, connected),
    appendLog: (seat, at, text) => void appendSeatLog(root, seat, at, text),
  }
}

async function liveRun(root: string, options: WatchdogOptions): Promise<Report> {
  // Never autostart: a watchdog that brought up a broker would own it, and the broker serves every session.
  const client = new BrokerClient(() => undefined, undefined, undefined, undefined, undefined, {
    autoStart: false,
  })
  try {
    await client.connect()
    const lines = await runWatchdog(liveDeps(root, client), options)
    return { ok: true, lines }
  } finally {
    client.close()
  }
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
    const eligible = scorerEligible(root, name)
    lines.push(`${name}: eligible ${eligible ?? 'unknown'} is TODAY's scorer count, assumed for ${day}`)
    const pool = parsePools(charter).get(seat.pool)
    lines.push(...renderReplay(name, replay({ seat, pool, events, readings, eligible }, times)))
  }
  return { ok: true, lines }
}

export const seatsWatchdogVerb = defineVerb({
  name: 'seats.watchdog',
  description:
    'wake an autonomy seat idle with budget and eligible work (CC-203); silent otherwise. ' +
    'Never wakes a seat named in the `stopped` map of $AGENT_CHAT_HOME/seat-watchdog.json ' +
    '({"stopped": {"<seat>": "<reason>"}}; delete the entry to re-enable), a seat whose latest ' +
    'log line starts BUDGET-PAUSE or PARKED, a seat at its spend stop, or any seat while the ' +
    'owner seat has announced a broker restart without "restart done"',
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

/** The install verb's body, taking its `JobControl` explicitly so a test can inject a stub. */
export function watchdogInstall(control: JobControl): Report {
  const plist = renderWatchdogPlist({
    label: WATCHDOG_LABEL,
    nodePath: process.execPath,
    cliEntry: cliEntry(),
    logDir: watchdogLogDir(),
    env: jobEnv(process.env),
    minutes: WATCHDOG_MINUTES,
  })
  // No kickstart: the first wake waits for the next scheduled minute, not the install.
  const result = startJob({ plist: watchdogPlistPath(), logDir: watchdogLogDir() }, plist, control, {
    kickstart: false,
  })
  return control.dryRun ? { ok: true, lines: [plist, ...result.lines] } : result
}

export const seatsWatchdogInstallVerb = defineVerb({
  name: 'seats.watchdog-install',
  description:
    'install the launchd job that runs `seats watchdog` four times an hour; the first run waits for the next scheduled minute',
  args: z.object({ dryRun: z.boolean().optional() }),
  result: Report,
  cli: {
    options: {
      dryRun: { long: '--dry-run', description: 'print the plist and launchctl calls; load nothing' },
    },
  },
  async run({ dryRun }) {
    const control = {
      launchctl: systemLaunchctl,
      uid: process.getuid?.() ?? 0,
      dryRun: dryRun === true,
      label: WATCHDOG_LABEL,
    }
    return watchdogInstall(control)
  },
})

export function addSeatsCommands(program: Commander): void {
  const seats = program.command('seats').description('autonomy seats: the idle watchdog')
  addVerb(seats, seatsWatchdogVerb)
  addVerb(seats, seatsWatchdogInstallVerb)
}
