import os from 'node:os'
import path from 'node:path'
import { WATCHDOG_MINUTES } from '../../agents/seats/watchdog.js'
import {
  describeLaunchd,
  launchdControl,
  unitControl,
  usesSystemd,
  type JobHost,
} from '../../mirror/job-host.js'
import { jobState, startJob, stopJob, type JobControl } from '../../mirror/launchd.js'
import { agentChatHomeRefusals, jobEnv, renderPlist, watchdogJob } from '../../mirror/plist.js'
import { installUnits, uninstallUnits, unitStatus } from '../../mirror/systemd.js'
import { renderUnits, unitName, unitNameForHome, type RenderedUnits } from '../../mirror/systemd-unit.js'
import { WATCHDOG_LABEL, cliEntry, linuxJobLogDir, watchdogLogDir, watchdogPlistPath } from '../../paths.js'
import type { Report } from '../command.js'

/** `--agent-chat-home`: the home the job runs against, winning over the installing shell's AGENT_CHAT_HOME. */
export interface WatchdogTarget {
  agentChatHome?: string | undefined
}

const defaultHome = (): string => path.join(os.homedir(), '.agent-chat')

const flagHome = (target: WatchdogTarget): string | undefined =>
  target.agentChatHome === undefined ? undefined : path.resolve(target.agentChatHome)

const effectiveHome = (target: WatchdogTarget): string =>
  flagHome(target) ?? (process.env.AGENT_CHAT_HOME || defaultHome())

const linuxName = (target: WatchdogTarget): string =>
  unitNameForHome(unitName(WATCHDOG_LABEL), effectiveHome(target), defaultHome())

const linuxLogDir = (target: WatchdogTarget): string => linuxJobLogDir(linuxName(target))

function env(target: WatchdogTarget): Record<string, string> {
  const home = flagHome(target)
  return jobEnv(home === undefined ? process.env : { ...process.env, AGENT_CHAT_HOME: home })
}

const spec = (logDir: string, target: WatchdogTarget) =>
  watchdogJob({
    label: WATCHDOG_LABEL,
    nodePath: process.execPath,
    cliEntry: cliEntry(),
    logDir,
    env: env(target),
    minutes: WATCHDOG_MINUTES,
  })

const units = (target: WatchdogTarget): RenderedUnits =>
  renderUnits(spec(linuxLogDir(target), target), linuxName(target))

/** A scratch or worktree home vanishes under the job, so an explicit one is refused before anything renders. */
function refusal(target: WatchdogTarget): Report | null {
  const home = flagHome(target)
  const errors = home === undefined ? [] : agentChatHomeRefusals(home, os.tmpdir())
  return errors.length === 0 ? null : { ok: false, lines: [], errors }
}

/** The darwin install body, taking its `JobControl` explicitly so a test can inject a stub. */
export function watchdogInstall(control: JobControl, target: WatchdogTarget = {}): Report {
  const refused = refusal(target)
  if (refused !== null) return refused
  const plist = renderPlist(spec(watchdogLogDir(), target))
  // No kickstart: the first wake waits for the next scheduled minute, not the install.
  const result = startJob({ plist: watchdogPlistPath(), logDir: watchdogLogDir() }, plist, control, {
    kickstart: false,
  })
  return control.dryRun ? { ok: true, lines: [plist, ...result.lines] } : result
}

export function watchdogInstallOn(host: JobHost, target: WatchdogTarget = {}): Report {
  if (!usesSystemd(host)) return watchdogInstall(launchdControl(host, WATCHDOG_LABEL), target)
  const refused = refusal(target)
  if (refused !== null) return refused
  const rendered = units(target)
  // An OnCalendar timer never fires on enable, so the first wake waits for the next scheduled minute here too.
  const result = installUnits(unitControl(host), rendered, linuxLogDir(target))
  if (!host.dryRun) return result
  return { ok: true, lines: [rendered.service, rendered.timer ?? '', ...result.lines] }
}

export function watchdogUninstallOn(host: JobHost, target: WatchdogTarget = {}): Report {
  if (usesSystemd(host)) return uninstallUnits(unitControl(host), units(target))
  return stopJob(launchdControl(host, WATCHDOG_LABEL))
}

export function watchdogStatusOn(host: JobHost, target: WatchdogTarget = {}): Report {
  if (usesSystemd(host)) return { ok: true, lines: unitStatus(unitControl(host), units(target)) }
  const state = jobState(launchdControl(host, WATCHDOG_LABEL))
  return { ok: true, lines: [`launchd ${describeLaunchd(state)}`, `plist ${watchdogPlistPath()}`] }
}
