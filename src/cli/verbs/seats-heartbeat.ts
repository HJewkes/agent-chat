import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { parseSeat } from '../../agents/seats/charter.js'
import {
  heartbeatGaps,
  pauseHolds,
  renderGaps,
  type DeliveryRow,
  type Hold,
} from '../../agents/seats/heartbeat-gaps.js'
import { HEARTBEAT_UNIT_PREFIX, type HeartbeatJobContext } from '../../agents/seats/heartbeat-external.js'
import { installHeartbeats, refreshHeartbeat } from '../../agents/seats/heartbeat-install.js'
import { defaultAutonomyRoot, readSeatJournal, readText, seatFileNames } from '../../agents/seats/io.js'
import { jobEnv } from '../../mirror/plist.js'
import { requiredString } from '../../args.js'
import { cliEntry, linuxJobLogDir, logPath, systemdUserUnitDir } from '../../paths.js'
import { defineVerb, Report } from '../command.js'

const jobContext = (root: string): HeartbeatJobContext => ({
  nodePath: process.execPath,
  cliEntry: cliEntry(),
  root: path.resolve(root),
  env: jobEnv(process.env),
  logDir: linuxJobLogDir(`${HEARTBEAT_UNIT_PREFIX}seats`),
})

const readSeatFile = (root: string, seat: string): string | undefined =>
  readText(path.join(root, 'seats', `${seat}.md`))

const seatFileReader =
  (root: string) =>
  (seat: string): string | undefined =>
    readSeatFile(root, seat)

/** The watchdog's relaunch hook: refresh only units already in the systemd user dir; it never installs one. */
export const refreshSeatHeartbeat = (root: string, seat: string): string | undefined =>
  refreshHeartbeat(
    {
      readSeatFile: seatFileReader(root),
      ctx: jobContext(root),
      targetDir: systemdUserUnitDir(),
      tmpdir: os.tmpdir(),
    },
    seat,
  )

const failed = (err: unknown): Report => ({
  ok: false,
  lines: [],
  errors: [err instanceof Error ? err.message : String(err)],
})

const ROOT_FLAG = { long: '--root', description: 'autonomy directory holding seats/ and logs/' }

export const seatsHeartbeatInstallVerb = defineVerb({
  name: 'seats.heartbeat-install',
  description:
    "render one systemd --user service and timer per seat (CC-947) that fires on the seat file's " +
    "heartbeat_cron minutes and sends the charter heartbeat when the seat logged no tick line for its cron's widest gap plus 5 min. " +
    "Writes the unit files only: it never runs systemctl, so enabling the timers stays the owner's call",
  args: z.object({
    root: z.string().optional(),
    targetDir: z.string().optional(),
    dryRun: z.boolean().optional(),
    seat: z.array(z.string()).optional(),
  }),
  result: Report,
  cli: {
    options: {
      root: ROOT_FLAG,
      targetDir: {
        long: '--target-dir',
        description: 'directory to write the units into (default the systemd --user unit dir)',
      },
      dryRun: { long: '--dry-run', description: 'print every unit file; write nothing' },
      seat: { long: '--seat', description: 'only this seat (repeatable); default every file under seats/' },
    },
  },
  async run({ root, targetDir, dryRun, seat }) {
    const dir = root ?? defaultAutonomyRoot()
    try {
      return installHeartbeats({
        seats: seat ?? seatFileNames(dir),
        readSeatFile: seatFileReader(dir),
        ctx: jobContext(dir),
        targetDir: path.resolve(targetDir ?? systemdUserUnitDir()),
        print: dryRun === true,
        tmpdir: os.tmpdir(),
      })
    } catch (err) {
      return failed(err)
    }
  },
})

const HOUR_MS = 3_600_000

const readLogRows = (file: string, seat: string): DeliveryRow[] => {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  return text.split('\n').flatMap(line => {
    try {
      const row = JSON.parse(line) as {
        ts?: string
        event?: string
        seat?: string
        slot?: number
        ok?: boolean
      }
      if (row.seat !== seat || typeof row.event !== 'string' || typeof row.ts !== 'string') return []
      return [
        {
          event: row.event,
          at: Date.parse(row.ts),
          ...(row.slot === undefined ? {} : { slot: row.slot }),
          ...(row.ok === undefined ? {} : { ok: row.ok }),
        },
      ]
    } catch {
      return []
    }
  })
}

function holdsIn(root: string, seat: string, fromMs: number, toMs: number): Hold[] {
  const days = Math.ceil((toMs - fromMs) / (24 * HOUR_MS)) + 1
  return Array.from({ length: days }, (_, i) => new Date(toMs - i * 24 * HOUR_MS)).flatMap(at => {
    const journal = readSeatJournal(root, seat, at)
    return journal === undefined ? [] : pauseHolds(journal, at)
  })
}

export const seatsHeartbeatGapsVerb = defineVerb({
  name: 'seats.heartbeat-gaps',
  description:
    "report where a seat's heartbeat deliveries (heartbeat_watchdog and heartbeat_external rows in broker.log) " +
    "stopped for longer than its heartbeat_cron's widest gap plus 5 min, outside its BUDGET-PAUSE stretches, " +
    'and each slot that got two deliveries (CC-391). Exits non-zero when it finds either',
  args: z.object({
    seat: requiredString('seat'),
    hours: z.number().positive().optional(),
    root: z.string().optional(),
  }),
  result: Report,
  cli: {
    options: {
      seat: { long: '--seat', description: 'the seat to report on (required)' },
      hours: { long: '--hours', description: 'how far back to look (default 24)' },
      root: ROOT_FLAG,
    },
  },
  async run({ seat, hours, root }) {
    const dir = root ?? defaultAutonomyRoot()
    const cron = parseSeat(seat, readSeatFile(dir, seat) ?? '')?.heartbeatCron
    if (cron === undefined) return failed(new Error(`seats/${seat}.md has no heartbeat_cron`))
    const toMs = Date.now()
    const fromMs = toMs - (hours ?? 24) * HOUR_MS
    try {
      const rows = [...readLogRows(`${logPath()}.1`, seat), ...readLogRows(logPath(), seat)]
      const report = heartbeatGaps({ cron, rows, holds: holdsIn(dir, seat, fromMs, toMs), fromMs, toMs })
      return {
        ok: report.gaps.length === 0 && report.doubles.length === 0,
        lines: renderGaps(seat, hours ?? 24, report),
      }
    } catch (err) {
      return failed(err)
    }
  },
})
