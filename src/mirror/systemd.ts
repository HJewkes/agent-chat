import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { LaunchctlResult } from './launchd.js'
import type { RenderedUnits } from './systemd-unit.js'

/** Injected so tests never touch the real systemd user manager; takes the args after `systemctl`. */
export type Systemctl = (args: string[]) => LaunchctlResult

export const systemSystemctl: Systemctl = args => {
  const result = spawnSync('systemctl', args, { encoding: 'utf8' })
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

export interface UnitControl {
  systemctl: Systemctl
  dryRun: boolean
  /** `$XDG_CONFIG_HOME/systemd/user`, where the user manager reads units. */
  unitDir: string
}

interface UnitFile {
  file: string
  text: string
}

/** The timer drives a scheduled job, so it is the unit enabled; a kept-alive job enables its service. */
const primaryUnit = (units: RenderedUnits): string =>
  `${units.name}.${units.timer === undefined ? 'service' : 'timer'}`

function unitFiles(control: UnitControl, units: RenderedUnits): UnitFile[] {
  const service = { file: path.join(control.unitDir, `${units.name}.service`), text: units.service }
  if (units.timer === undefined) return [service]
  return [service, { file: path.join(control.unitDir, `${units.name}.timer`), text: units.timer }]
}

function run(control: UnitControl, args: string[], lines: string[]): LaunchctlResult {
  const full = ['--user', ...args]
  lines.push(`systemctl ${full.join(' ')}`)
  if (control.dryRun) return { code: 0, stdout: '', stderr: '' }
  const result = control.systemctl(full)
  if (result.code !== 0) lines.push(`  exit ${result.code}: ${result.stderr.trim()}`)
  return result
}

type WriteOutcome = 'unchanged' | 'write' | 'rewrite'

function writeUnit(unit: UnitFile, dryRun: boolean, lines: string[]): WriteOutcome {
  const current = fs.existsSync(unit.file) ? fs.readFileSync(unit.file, 'utf8') : null
  if (current === unit.text) return 'unchanged'
  const outcome = current === null ? 'write' : 'rewrite'
  lines.push(`${outcome} ${unit.file}`)
  if (dryRun) return outcome
  fs.mkdirSync(path.dirname(unit.file), { recursive: true })
  fs.writeFileSync(unit.file, unit.text, { mode: 0o644 })
  return outcome
}

/** Writes changed units, reloads the manager, enables and starts the primary unit, restarting it if rewritten. */
export function installUnits(
  control: UnitControl,
  units: RenderedUnits,
  logDir: string,
): { ok: boolean; lines: string[] } {
  const lines: string[] = []
  const outcomes = unitFiles(control, units).map(unit => writeUnit(unit, control.dryRun, lines))
  if (!control.dryRun) fs.mkdirSync(logDir, { recursive: true })
  if (run(control, ['daemon-reload'], lines).code !== 0) return { ok: false, lines }
  const primary = primaryUnit(units)
  if (run(control, ['enable', '--now', primary], lines).code !== 0) return { ok: false, lines }
  if (!outcomes.includes('rewrite')) return { ok: true, lines }
  return { ok: run(control, ['restart', primary], lines).code === 0, lines }
}

/** Stops and disables the primary unit, removes the unit files, and reloads the manager. */
export function uninstallUnits(control: UnitControl, units: RenderedUnits): { ok: boolean; lines: string[] } {
  const lines: string[] = []
  run(control, ['disable', '--now', primaryUnit(units)], lines)
  const present = unitFiles(control, units).filter(unit => fs.existsSync(unit.file))
  if (present.length === 0) lines.push('no unit files')
  for (const unit of present) {
    lines.push(`remove ${unit.file}`)
    if (!control.dryRun) fs.rmSync(unit.file, { force: true })
  }
  run(control, ['daemon-reload'], lines)
  return { ok: true, lines }
}

const SHOWN = ['LoadState', 'ActiveState', 'SubState', 'NextElapseUSecRealtime'] as const

function showUnit(control: UnitControl, unit: string): Record<string, string> {
  const shown = control.systemctl(['--user', 'show', unit, `--property=${SHOWN.join(',')}`])
  const props: Record<string, string> = {}
  if (shown.code !== 0) return props
  for (const line of shown.stdout.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) props[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return props
}

/** One line per unit: `systemd <unit> active (waiting), next <time>`, or `not loaded`. */
export function unitStatus(control: UnitControl, units: RenderedUnits): string[] {
  return unitFiles(control, units).map(({ file }) => {
    const unit = path.basename(file)
    const props = showUnit(control, unit)
    if (props.LoadState === undefined || props.LoadState === 'not-found') return `systemd ${unit} not loaded`
    const next = props.NextElapseUSecRealtime ? `, next ${props.NextElapseUSecRealtime}` : ''
    return `systemd ${unit} ${props.ActiveState} (${props.SubState})${next}`
  })
}
