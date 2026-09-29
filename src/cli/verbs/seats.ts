import path from 'node:path'
import type { Command as Commander } from 'commander'
import { z } from 'zod'
import { readAccountBudget } from '../../agents/budget.js'
import { charterSeats, parsePools, parseSeat } from '../../agents/seats/charter.js'
import {
  appendSeatLog,
  defaultAutonomyRoot,
  loadStates,
  readAgentEvents,
  readText,
  saveStates,
  scorerEligible,
} from '../../agents/seats/io.js'
import {
  parseLogReadings,
  parseReadingFlag,
  replay,
  runTimes,
  type ReplayRow,
} from '../../agents/seats/replay.js'
import { runWatchdog, type Roster, type WakeResult, type WatchdogDeps } from '../../agents/seats/run.js'
import { WATCHDOG_MINUTES } from '../../agents/seats/watchdog.js'
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
async function wake(
  client: BrokerClient,
  seat: string,
  message: string,
  connected: boolean,
): Promise<WakeResult> {
  if (connected) {
    const res = (await client.request(
      { t: 'human_send', to: seat, text: message },
      'send_result',
    )) as Reply<'send_result'>
    return res.ok
      ? { ok: true, detail: `message ${res.msgId}` }
      : { ok: false, detail: res.reason ?? 'send refused' }
  }
  const frame = { t: 'resume' as const, name: seat, surface: 'headless' as const, message }
  const res = (await client.request(frame, 'spawn_result')) as Reply<'spawn_result'>
  return res.ok ? { ok: true, detail: 'resumed' } : { ok: false, detail: res.reason ?? 'resume refused' }
}

function liveDeps(root: string, client: BrokerClient): WatchdogDeps {
  return {
    now: () => new Date(),
    readCharter: () => readText(path.join(root, 'charter.md')),
    readSeatFile: seat => readText(path.join(root, 'seats', `${seat}.md`)),
    readBudget: (dir, nowMs) => readAccountBudget(dir, nowMs),
    roster: () => roster(client),
    eligible: seat => scorerEligible(root, seat),
    loadStates: () => loadStates(),
    saveStates: states => saveStates(states),
    wake: (seat, message, connected) => wake(client, seat, message, connected),
    appendLog: (seat, at, text) => void appendSeatLog(root, seat, at, text),
  }
}

async function liveRun(root: string, seats: string[] | undefined, dryRun: boolean): Promise<Report> {
  // Never autostart: a watchdog that brought up a broker would own it, and the broker serves every session.
  const client = new BrokerClient(() => undefined, undefined, undefined, undefined, undefined, {
    autoStart: false,
  })
  try {
    await client.connect()
    const lines = await runWatchdog(liveDeps(root, client), {
      dryRun,
      ...(seats === undefined ? {} : { seats }),
    })
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
  for (const name of seats ?? charterSeats(charter)) {
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
  description: 'wake an autonomy seat idle with budget and eligible work (CC-203); silent otherwise',
  args: z.object({
    dryRun: z.boolean().optional(),
    replay: z.string().optional(),
    seat: z.array(z.string()).optional(),
    reading: z.array(z.string()).optional(),
    root: z.string().optional(),
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
    },
  },
  async run({ dryRun, replay: day, seat, reading, root }) {
    const dir = root ?? defaultAutonomyRoot()
    try {
      if (day !== undefined) return replayRun(dir, day, seat, reading ?? [])
      return await liveRun(dir, seat, dryRun === true)
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
  const result = startJob({ plist: watchdogPlistPath(), logDir: watchdogLogDir() }, plist, control)
  return control.dryRun ? { ok: true, lines: [plist, ...result.lines] } : result
}

export const seatsWatchdogInstallVerb = defineVerb({
  name: 'seats.watchdog-install',
  description: 'install and start the launchd job that runs `seats watchdog` four times an hour',
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
