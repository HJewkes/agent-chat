import { WATCHDOG_MINUTES } from '../../agents/seats/watchdog.js'
import {
  describeLaunchd,
  launchdControl,
  unitControl,
  usesSystemd,
  type JobHost,
} from '../../mirror/job-host.js'
import { jobState, startJob, stopJob, type JobControl } from '../../mirror/launchd.js'
import { jobEnv, renderPlist, watchdogJob } from '../../mirror/plist.js'
import { installUnits, uninstallUnits, unitStatus } from '../../mirror/systemd.js'
import { renderUnits, unitName, type RenderedUnits } from '../../mirror/systemd-unit.js'
import { WATCHDOG_LABEL, cliEntry, linuxJobLogDir, watchdogLogDir, watchdogPlistPath } from '../../paths.js'
import type { Report } from '../command.js'

const linuxLogDir = (): string => linuxJobLogDir(unitName(WATCHDOG_LABEL))

const spec = (logDir: string) =>
  watchdogJob({
    label: WATCHDOG_LABEL,
    nodePath: process.execPath,
    cliEntry: cliEntry(),
    logDir,
    env: jobEnv(process.env),
    minutes: WATCHDOG_MINUTES,
  })

const units = (): RenderedUnits => renderUnits(spec(linuxLogDir()))

/** The darwin install body, taking its `JobControl` explicitly so a test can inject a stub. */
export function watchdogInstall(control: JobControl): Report {
  const plist = renderPlist(spec(watchdogLogDir()))
  // No kickstart: the first wake waits for the next scheduled minute, not the install.
  const result = startJob({ plist: watchdogPlistPath(), logDir: watchdogLogDir() }, plist, control, {
    kickstart: false,
  })
  return control.dryRun ? { ok: true, lines: [plist, ...result.lines] } : result
}

export function watchdogInstallOn(host: JobHost): Report {
  if (!usesSystemd(host)) return watchdogInstall(launchdControl(host, WATCHDOG_LABEL))
  const rendered = units()
  // An OnCalendar timer never fires on enable, so the first wake waits for the next scheduled minute here too.
  const result = installUnits(unitControl(host), rendered, linuxLogDir())
  if (!host.dryRun) return result
  return { ok: true, lines: [rendered.service, rendered.timer ?? '', ...result.lines] }
}

export function watchdogUninstallOn(host: JobHost): Report {
  if (usesSystemd(host)) return uninstallUnits(unitControl(host), units())
  return stopJob(launchdControl(host, WATCHDOG_LABEL))
}

export function watchdogStatusOn(host: JobHost): Report {
  if (usesSystemd(host)) return { ok: true, lines: unitStatus(unitControl(host), units()) }
  const state = jobState(launchdControl(host, WATCHDOG_LABEL))
  return { ok: true, lines: [`launchd ${describeLaunchd(state)}`, `plist ${watchdogPlistPath()}`] }
}
