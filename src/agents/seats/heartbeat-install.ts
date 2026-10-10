import fs from 'node:fs'
import path from 'node:path'
import type { RenderedUnits } from '../../mirror/systemd-unit.js'
import { isSeatName, parseSeat } from './charter.js'
import { heartbeatUnitName, heartbeatUnits, type HeartbeatJobContext } from './heartbeat-external.js'

/**
 * CC-947: writes each seat's heartbeat service and timer into a unit directory. It never runs
 * systemctl: enabling the timers is the owner's decision, so the output only names the command.
 */

export interface HeartbeatInstallInput {
  /** The seat names under `seats/`; a name that is not a seat slug is skipped. */
  seats: string[]
  readSeatFile: (seat: string) => string | undefined
  ctx: HeartbeatJobContext
  targetDir: string
  /** Print the units and write nothing. */
  print: boolean
}

export interface InstallResult {
  ok: boolean
  lines: string[]
}

interface UnitFile {
  file: string
  text: string
}

const unitFiles = (dir: string, units: RenderedUnits): UnitFile[] => [
  { file: path.join(dir, `${units.name}.service`), text: units.service },
  { file: path.join(dir, `${units.name}.timer`), text: units.timer ?? '' },
]

/** `write`, `rewrite` or undefined when the file already holds `text`. */
function writeUnit(unit: UnitFile): string | undefined {
  const current = fs.existsSync(unit.file) ? fs.readFileSync(unit.file, 'utf8') : undefined
  if (current === unit.text) return undefined
  fs.mkdirSync(path.dirname(unit.file), { recursive: true })
  fs.writeFileSync(unit.file, unit.text, { mode: 0o644 })
  return `${current === undefined ? 'write' : 'rewrite'} ${unit.file}`
}

function seatUnits(input: HeartbeatInstallInput, seat: string): RenderedUnits | string {
  if (!isSeatName(seat)) return 'not a seat name'
  const parsed = parseSeat(seat, input.readSeatFile(seat) ?? '')
  if (parsed === undefined) return `seats/${seat}.md has no prefix or pool`
  return heartbeatUnits(seat, parsed.heartbeatCron, input.ctx)
}

function installSeat(input: HeartbeatInstallInput, seat: string): string[] {
  const units = seatUnits(input, seat)
  if (typeof units === 'string') return [`${seat}: skipped, ${units}`]
  const files = unitFiles(input.targetDir, units)
  if (input.print) return files.flatMap(unit => [`# ${unit.file}`, unit.text])
  const written = files.flatMap(unit => writeUnit(unit) ?? [])
  return written.length === 0 ? [`${seat}: unchanged ${units.name}`] : written
}

export function installHeartbeats(input: HeartbeatInstallInput): InstallResult {
  const lines = input.seats.flatMap(seat => installSeat(input, seat))
  const timers = input.seats.filter(isSeatName).map(seat => `${heartbeatUnitName(seat)}.timer`)
  lines.push(
    `not enabled: enabling is the owner's call; to enable, run systemctl --user daemon-reload && ` +
      `systemctl --user enable --now ${timers.join(' ')}`,
  )
  return { ok: true, lines }
}

/**
 * The watchdog's relaunch path: re-render one seat's units, but only where its timer was already
 * installed, so a relaunch never installs a timer the owner has not. Undefined when nothing changed.
 */
export function refreshHeartbeat(
  input: Omit<HeartbeatInstallInput, 'seats' | 'print'>,
  seat: string,
): string | undefined {
  if (!fs.existsSync(path.join(input.targetDir, `${heartbeatUnitName(seat)}.timer`))) return undefined
  const lines = installSeat({ ...input, seats: [seat], print: false }, seat)
  const changed = lines.filter(line => line.startsWith('write ') || line.startsWith('rewrite '))
  if (lines.some(line => line.startsWith(`${seat}: skipped`))) return lines.join('; ')
  return changed.length === 0
    ? undefined
    : `heartbeat units refreshed (${changed.join('; ')}); daemon-reload to apply`
}
