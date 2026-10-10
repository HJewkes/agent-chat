import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { logEvent } from '../../broker/log.js'
import { requiredString } from '../../args.js'
import { isSeatName } from '../../agents/seats/charter.js'
import { checkHeartbeat, type HeartbeatCheckDeps } from '../../agents/seats/heartbeat-check.js'
import { HEARTBEAT_UNIT_PREFIX, type HeartbeatJobContext } from '../../agents/seats/heartbeat-external.js'
import { installHeartbeats, refreshHeartbeat } from '../../agents/seats/heartbeat-install.js'
import { defaultAutonomyRoot, readSeatJournal, readText, seatFileNames } from '../../agents/seats/io.js'
import { jobEnv, launchdJobRefusals } from '../../mirror/plist.js'
import { cliEntry, linuxJobLogDir, systemdUserUnitDir } from '../../paths.js'
import { defineVerb, Report } from '../command.js'
import { sendAsOwner, withRunningBroker } from './seat-broker.js'

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
    { readSeatFile: seatFileReader(root), ctx: jobContext(root), targetDir: systemdUserUnitDir() },
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
    const ctx = jobContext(dir)
    // A unit pointing into a worktree dies with MODULE_NOT_FOUND once the tree is parked.
    const errors = dryRun === true ? [] : launchdJobRefusals({ ...ctx, tmpdir: os.tmpdir() })
    if (errors.length > 0) return { ok: false, lines: [], errors }
    try {
      return installHeartbeats({
        seats: seat ?? seatFileNames(dir),
        readSeatFile: seatFileReader(dir),
        ctx,
        targetDir: path.resolve(targetDir ?? systemdUserUnitDir()),
        print: dryRun === true,
      })
    } catch (err) {
      return failed(err)
    }
  },
})

const checkDeps = (root: string, send: HeartbeatCheckDeps['send']): HeartbeatCheckDeps => ({
  now: () => new Date(),
  readSeatFile: seatFileReader(root),
  readSeatLog: (name, at) => readSeatJournal(root, name, at),
  send,
  logEvent,
})

const noSend: HeartbeatCheckDeps['send'] = () => Promise.reject(new Error('a dry run sends nothing'))

export const seatsHeartbeatCheckVerb = defineVerb({
  name: 'seats.heartbeat-check',
  description:
    "what a seat's heartbeat timer runs (CC-947): when the seat's log has no tick line for its cron's widest gap plus 5 min and no " +
    'WRAP, PARKED or BUDGET-PAUSE as its latest line, send the charter heartbeat through the broker and ' +
    'log heartbeat_external',
  args: z.object({
    seat: requiredString('seat'),
    root: z.string().optional(),
    dryRun: z.boolean().optional(),
  }),
  result: Report,
  cli: {
    options: {
      seat: { long: '--seat', description: 'the seat to check (required)' },
      root: ROOT_FLAG,
      dryRun: { long: '--dry-run', description: 'print the decision; send nothing and need no broker' },
    },
  },
  async run({ seat, root, dryRun }) {
    if (!isSeatName(seat)) return failed(new Error(`not a seat name: ${seat}`))
    const dir = root ?? defaultAutonomyRoot()
    try {
      const result =
        dryRun === true
          ? await checkHeartbeat(checkDeps(dir, noSend), seat, true)
          : await withRunningBroker(client =>
              checkHeartbeat(
                checkDeps(dir, (name, message) => sendAsOwner(client, name, message)),
                seat,
                false,
              ),
            )
      return { ok: result.ok, lines: [result.line] }
    } catch (err) {
      return failed(err)
    }
  },
})
