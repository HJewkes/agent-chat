import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { HEARTBEAT_UNIT_PREFIX, type HeartbeatJobContext } from '../../agents/seats/heartbeat-external.js'
import { installHeartbeats, refreshHeartbeat } from '../../agents/seats/heartbeat-install.js'
import { defaultAutonomyRoot, readText, seatFileNames } from '../../agents/seats/io.js'
import { jobEnv } from '../../mirror/plist.js'
import { cliEntry, linuxJobLogDir, systemdUserUnitDir } from '../../paths.js'
import { defineVerb, Report } from '../command.js'

const jobContext = (root: string): HeartbeatJobContext => ({
  nodePath: process.execPath,
  cliEntry: cliEntry(),
  root: path.resolve(root),
  env: jobEnv(process.env),
  logDir: linuxJobLogDir(`${HEARTBEAT_UNIT_PREFIX}seats`),
})

const seatFileReader =
  (root: string) =>
  (seat: string): string | undefined =>
    readText(path.join(root, 'seats', `${seat}.md`))

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
