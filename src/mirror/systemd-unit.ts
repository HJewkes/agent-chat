import type { JobSpec, PlistSchedule } from './plist.js'

/** Unit names drop the launchd reverse-DNS prefix, as active-work's `active-work.service` does. */
const LABEL_PREFIX = 'dev.hjewkes.'

export const unitName = (label: string): string =>
  label.startsWith(LABEL_PREFIX) ? label.slice(LABEL_PREFIX.length) : label

/** The units for one job; `timer` is absent for a kept-alive service. */
export interface RenderedUnits {
  name: string
  service: string
  timer?: string
}

/** `%` starts a unit specifier everywhere in a unit file. */
const escapeSpecifiers = (text: string): string => text.replace(/%/g, '%%')

/** An ExecStart argument: `$` would expand a variable, and whitespace or quotes need double quotes. */
export function quoteArg(arg: string): string {
  const escaped = escapeSpecifiers(arg).replace(/\$/g, '$$$$')
  if (!/[\s"'\\]/.test(arg)) return escaped
  return `"${escaped.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

const envLine = (key: string, value: string): string =>
  `Environment="${escapeSpecifiers(`${key}=${value}`).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

function restartLines(schedule: PlistSchedule): string[] {
  if (schedule.kind !== 'keep-alive') return ['Type=oneshot']
  return ['Type=simple', 'Restart=always', `RestartSec=${schedule.throttleIntervalSeconds}`]
}

function renderService(spec: JobSpec, timed: boolean): string {
  const logFile = escapeSpecifiers(spec.logFile)
  return [
    '[Unit]',
    `Description=${escapeSpecifiers(spec.label)}`,
    '',
    '[Service]',
    ...restartLines(spec.schedule),
    `ExecStart=${spec.args.map(quoteArg).join(' ')}`,
    ...Object.entries(spec.env).map(([key, value]) => envLine(key, value)),
    `StandardOutput=append:${logFile}`,
    `StandardError=append:${logFile}`,
    ...(timed ? [] : ['', '[Install]', 'WantedBy=default.target']),
    '',
  ].join('\n')
}

const pad = (minute: number): string => String(minute).padStart(2, '0')

function triggerLines(schedule: Exclude<PlistSchedule, { kind: 'keep-alive' }>): string[] {
  if (schedule.kind === 'interval')
    return [`OnBootSec=${schedule.seconds}s`, `OnUnitActiveSec=${schedule.seconds}s`]
  return schedule.minutes.map(m => `OnCalendar=*-*-* *:${pad(m)}:00`)
}

function renderTimer(name: string, schedule: Exclude<PlistSchedule, { kind: 'keep-alive' }>): string {
  return [
    '[Unit]',
    `Description=Schedule for ${name}.service`,
    '',
    '[Timer]',
    ...triggerLines(schedule),
    // The default one-minute accuracy would drift the fixed minutes a watchdog replay relies on.
    'AccuracySec=1s',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n')
}

/** Pure: the systemd --user units equivalent to `renderPlist(spec)`; like the plist, they hold no token. */
export function renderUnits(spec: JobSpec): RenderedUnits {
  const name = unitName(spec.label)
  const { schedule } = spec
  if (schedule.kind === 'keep-alive') return { name, service: renderService(spec, false) }
  return { name, service: renderService(spec, true), timer: renderTimer(name, schedule) }
}
