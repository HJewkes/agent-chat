import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface LaunchctlResult {
  code: number
  stdout: string
  stderr: string
}

/** Injected so tests never touch the real launchd domain. */
export type Launchctl = (args: string[]) => LaunchctlResult

export const systemLaunchctl: Launchctl = args => {
  const result = spawnSync('launchctl', args, { encoding: 'utf8' })
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

export interface JobPaths {
  plist: string
  logDir: string
}

export interface JobControl {
  launchctl: Launchctl
  uid: number
  dryRun: boolean
  /** The launchd label this control governs; mirror and burndown each pass their own. */
  label: string
}

const domain = (uid: number): string => `gui/${uid}`
const service = (label: string, uid: number): string => `${domain(uid)}/${label}`

export interface JobState {
  loaded: boolean
  pid: number | null
  /** `mirror stop` disables the label; a disabled job stays down at login and never counts as a crash. */
  disabled: boolean
}

function labelDisabled(control: Pick<JobControl, 'launchctl' | 'uid' | 'label'>): boolean {
  const listed = control.launchctl(['print-disabled', domain(control.uid)])
  if (listed.code !== 0) return false
  const escaped = control.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`"${escaped}"\\s*=>\\s*(disabled|true)\\b`).test(listed.stdout)
}

/** `launchctl print` exits non-zero for an unknown service; a loaded one reports `pid = N` while running. */
function loadedState(control: Pick<JobControl, 'launchctl' | 'uid' | 'label'>): Omit<JobState, 'disabled'> {
  const printed = control.launchctl(['print', service(control.label, control.uid)])
  const pidText = printed.code === 0 ? /^\s*pid = (\d+)/m.exec(printed.stdout)?.[1] : undefined
  return { loaded: printed.code === 0, pid: pidText === undefined ? null : Number.parseInt(pidText, 10) }
}

export function jobState(control: Pick<JobControl, 'launchctl' | 'uid' | 'label'>): JobState {
  const state = loadedState(control)
  // A running job is not stopped, so the extra launchctl call is only for one that is down.
  return { ...state, disabled: state.pid === null && labelDisabled(control) }
}

function run(control: JobControl, args: string[], lines: string[]): LaunchctlResult {
  lines.push(`launchctl ${args.join(' ')}`)
  if (control.dryRun) return { code: 0, stdout: '', stderr: '' }
  const result = control.launchctl(args)
  if (result.code !== 0) lines.push(`  exit ${result.code}: ${result.stderr.trim()}`)
  return result
}

/** True when the plist on disk differs from `rendered`, and so has to be rewritten. */
function writePlist(paths: JobPaths, rendered: string, dryRun: boolean, lines: string[]): boolean {
  const current = fs.existsSync(paths.plist) ? fs.readFileSync(paths.plist, 'utf8') : null
  if (current === rendered) return false
  lines.push(`${current === null ? 'write' : 'rewrite'} ${paths.plist}`)
  if (dryRun) return true
  fs.mkdirSync(path.dirname(paths.plist), { recursive: true })
  fs.mkdirSync(paths.logDir, { recursive: true })
  fs.writeFileSync(paths.plist, rendered, { mode: 0o644 })
  return true
}

/** Writes the plist if absent or changed, reloads a stale job, then bootstraps and kickstarts. */
export function startJob(
  paths: JobPaths,
  rendered: string,
  control: JobControl,
): { ok: boolean; lines: string[] } {
  const lines: string[] = []
  const changed = writePlist(paths, rendered, control.dryRun, lines)
  const { loaded } = loadedState(control)
  if (loaded && changed) run(control, ['bootout', service(control.label, control.uid)], lines)
  run(control, ['enable', service(control.label, control.uid)], lines)
  if (!loaded || changed) {
    const boot = run(control, ['bootstrap', domain(control.uid), paths.plist], lines)
    if (boot.code !== 0) return { ok: false, lines }
  }
  const kick = run(control, ['kickstart', service(control.label, control.uid)], lines)
  return { ok: kick.code === 0, lines }
}

/** Boots the job out and disables it, so a later login does not bring it back. */
export function stopJob(control: JobControl): { ok: boolean; lines: string[] } {
  const lines: string[] = []
  if (!loadedState(control).loaded) lines.push('not loaded')
  else run(control, ['bootout', service(control.label, control.uid)], lines)
  run(control, ['disable', service(control.label, control.uid)], lines)
  return { ok: true, lines }
}
