import fs from 'node:fs'
import path from 'node:path'
import { launchdJobRefusals } from '../../mirror/plist.js'
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
  /** The OS temp dir, so a home under it is refused like one inside a worktree. */
  tmpdir: string
}

export interface InstallResult {
  ok: boolean
  lines: string[]
  errors?: string[]
}

/** What became of one seat: its units rendered (printed, written or unchanged), skipped, or refused. */
export type SeatOutcome =
  | { kind: 'rendered'; seat: string; unit: string; lines: string[] }
  | { kind: 'skipped'; seat: string; lines: string[] }
  | { kind: 'refused'; seat: string; errors: string[] }

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

/**
 * The one place units are written, so every caller gets the same guard: a unit pointing into a
 * worktree or temp dir dies with MODULE_NOT_FOUND once the tree is parked, so writing one is refused.
 */
function installSeat(input: HeartbeatInstallInput, seat: string): SeatOutcome {
  const units = seatUnits(input, seat)
  if (typeof units === 'string') return { kind: 'skipped', seat, lines: [`${seat}: skipped, ${units}`] }
  const files = unitFiles(input.targetDir, units)
  const rendered = (lines: string[]): SeatOutcome => ({ kind: 'rendered', seat, unit: units.name, lines })
  if (input.print) return rendered(files.flatMap(unit => [`# ${unit.file}`, unit.text]))
  const errors = launchdJobRefusals({ ...input.ctx, tmpdir: input.tmpdir })
  if (errors.length > 0) return { kind: 'refused', seat, errors }
  const written = files.flatMap(unit => writeUnit(unit) ?? [])
  return rendered(written.length === 0 ? [`${seat}: unchanged ${units.name}`] : written)
}

const enableLine = (outcomes: SeatOutcome[]): string[] => {
  const timers = outcomes.flatMap(o => (o.kind === 'rendered' ? [`${o.unit}.timer`] : []))
  if (timers.length === 0) return []
  return [
    `not enabled: enabling is the owner's call; to enable, run systemctl --user daemon-reload && ` +
      `systemctl --user enable --now ${timers.join(' ')}`,
  ]
}

export function installHeartbeats(input: HeartbeatInstallInput): InstallResult {
  const outcomes = input.seats.map(seat => installSeat(input, seat))
  const lines = outcomes.flatMap(o => (o.kind === 'refused' ? [] : o.lines))
  const errors = [...new Set(outcomes.flatMap(o => (o.kind === 'refused' ? o.errors : [])))]
  if (errors.length > 0) return { ok: false, lines, errors }
  return { ok: true, lines: [...lines, ...enableLine(outcomes)] }
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
  const outcome = installSeat({ ...input, seats: [seat], print: false }, seat)
  if (outcome.kind === 'refused') return `heartbeat units not refreshed: ${outcome.errors.join('; ')}`
  if (outcome.kind === 'skipped') return outcome.lines.join('; ')
  const changed = outcome.lines.filter(line => line.startsWith('write ') || line.startsWith('rewrite '))
  return changed.length === 0
    ? undefined
    : `heartbeat units refreshed (${changed.join('; ')}); daemon-reload to apply`
}
