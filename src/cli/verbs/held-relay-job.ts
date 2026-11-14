import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { resolveAutoStart, resolveHeldRelay } from '../../config.js'
import {
  describeLaunchd,
  launchdControl,
  systemHost,
  unitControl,
  usesSystemd,
  type JobHost,
} from '../../mirror/job-host.js'
import { jobState, startJob, stopJob } from '../../mirror/launchd.js'
import { jobNodePath } from '../../mirror/node-path.js'
import { agentChatHomeRefusals, jobEnv, renderPlist, type JobSpec } from '../../mirror/plist.js'
import { installUnits, uninstallUnits, unitStatus } from '../../mirror/systemd.js'
import { renderUnits, unitName, unitNameForHome, type RenderedUnits } from '../../mirror/systemd-unit.js'
import {
  HELD_RELAY_LABEL,
  cliEntry,
  heldRelayLogDir,
  heldRelayPlistPath,
  linuxJobLogDir,
} from '../../paths.js'
import { defineVerb, Report } from '../command.js'

/** The held-relay job: `seats held-relay` every `heldRelay.everyMinutes`. The shape of `watchdog-job.ts`. */
export interface HeldRelayTarget {
  agentChatHome?: string | undefined
  everyMinutes: number
  /** Config `remoteBroker`: this host's events.db is not the broker's, so the relay would read stale mail. */
  remoteBroker?: boolean
}

export const REMOTE_BROKER_REFUSAL =
  'refused: config remoteBroker is true, so this host is not the broker host; install the relay where the broker runs'

const defaultHome = (): string => path.join(os.homedir(), '.agent-chat')

const flagHome = (target: HeldRelayTarget): string | undefined =>
  target.agentChatHome === undefined ? undefined : path.resolve(target.agentChatHome)

const effectiveHome = (target: HeldRelayTarget): string =>
  flagHome(target) ?? (process.env.AGENT_CHAT_HOME || defaultHome())

const linuxName = (target: HeldRelayTarget): string =>
  unitNameForHome(unitName(HELD_RELAY_LABEL), effectiveHome(target), defaultHome())

const linuxLogDir = (target: HeldRelayTarget): string => linuxJobLogDir(linuxName(target))

function env(target: HeldRelayTarget): Record<string, string> {
  const home = flagHome(target)
  return jobEnv(home === undefined ? process.env : { ...process.env, AGENT_CHAT_HOME: home })
}

const spec = (logDir: string, target: HeldRelayTarget): JobSpec => ({
  label: HELD_RELAY_LABEL,
  args: [jobNodePath(), cliEntry(), 'seats', 'held-relay'],
  logFile: path.join(logDir, 'held-relay.log'),
  runAtLoad: false,
  schedule: { kind: 'interval', seconds: target.everyMinutes * 60 },
  env: env(target),
})

const units = (target: HeldRelayTarget): RenderedUnits =>
  renderUnits(spec(linuxLogDir(target), target), linuxName(target))

/** The home a real install must vet: the flag's always, the shell's only when it is baked in for real. */
function vettedHome(target: HeldRelayTarget, dryRun: boolean): string | undefined {
  const home = flagHome(target)
  if (home !== undefined || dryRun) return home
  const shellHome = process.env.AGENT_CHAT_HOME
  return shellHome ? path.resolve(shellHome) : undefined
}

/** A scratch or worktree home vanishes under the job, so one is refused before anything renders. */
function refusal(target: HeldRelayTarget, dryRun: boolean): Report | null {
  if (target.remoteBroker === true) return { ok: false, lines: [], errors: [REMOTE_BROKER_REFUSAL] }
  if (target.agentChatHome === '')
    return { ok: false, lines: [], errors: ['refused: --agent-chat-home is empty'] }
  const home = vettedHome(target, dryRun)
  const errors = home === undefined ? [] : agentChatHomeRefusals(home, os.tmpdir())
  return errors.length === 0 ? null : { ok: false, lines: [], errors }
}

function launchdInstall(host: JobHost, target: HeldRelayTarget): Report {
  const control = launchdControl(host, HELD_RELAY_LABEL)
  const plist = renderPlist(spec(heldRelayLogDir(), target))
  const result = startJob({ plist: heldRelayPlistPath(), logDir: heldRelayLogDir() }, plist, control, {
    kickstart: false,
  })
  return host.dryRun ? { ok: true, lines: [plist, ...result.lines] } : result
}

export function heldRelayInstallOn(host: JobHost, target: HeldRelayTarget): Report {
  const refused = refusal(target, host.dryRun)
  if (refused !== null) return refused
  if (!usesSystemd(host)) return launchdInstall(host, target)
  const rendered = units(target)
  const result = installUnits(unitControl(host), rendered, linuxLogDir(target))
  if (!host.dryRun) return result
  return { ok: true, lines: [rendered.service, rendered.timer ?? '', ...result.lines] }
}

export function heldRelayUninstallOn(host: JobHost, target: HeldRelayTarget): Report {
  if (usesSystemd(host)) return uninstallUnits(unitControl(host), units(target))
  return stopJob(launchdControl(host, HELD_RELAY_LABEL))
}

export function heldRelayStatusOn(host: JobHost, target: HeldRelayTarget): Report {
  if (usesSystemd(host)) return { ok: true, lines: unitStatus(unitControl(host), units(target)) }
  const state = jobState(launchdControl(host, HELD_RELAY_LABEL))
  return { ok: true, lines: [`launchd ${describeLaunchd(state)}`, `plist ${heldRelayPlistPath()}`] }
}

const HOME_FLAG = {
  long: '--agent-chat-home',
  description:
    'the home the job runs against, over $AGENT_CHAT_HOME; on Linux a non-default home suffixes the unit names',
}

const target = (agentChatHome: string | undefined): HeldRelayTarget => ({
  agentChatHome,
  everyMinutes: resolveHeldRelay().everyMinutes,
  remoteBroker: !resolveAutoStart({}),
})

export const seatsHeldRelayInstallVerb = defineVerb({
  name: 'seats.held-relay-install',
  description:
    'install the launchd job (systemd --user units on Linux) that runs `seats held-relay` every ' +
    'heldRelay.everyMinutes on the broker host (refused where config remoteBroker is true); the pass ' +
    'stays a no-op until heldRelay.enabled',
  args: z.object({ dryRun: z.boolean().optional(), agentChatHome: z.string().optional() }),
  result: Report,
  cli: {
    options: {
      dryRun: {
        long: '--dry-run',
        description: 'print the plist and launchctl calls (units and systemctl calls on Linux); load nothing',
      },
      agentChatHome: HOME_FLAG,
    },
  },
  async run({ dryRun, agentChatHome }) {
    return heldRelayInstallOn(systemHost(dryRun === true), target(agentChatHome))
  },
})

export const seatsHeldRelayUninstallVerb = defineVerb({
  name: 'seats.held-relay-uninstall',
  description: 'stop the held-relay job and keep it from starting at login; on Linux, also remove its units',
  args: z.object({ agentChatHome: z.string().optional() }),
  result: Report,
  cli: { options: { agentChatHome: HOME_FLAG } },
  async run({ agentChatHome }) {
    return heldRelayUninstallOn(systemHost(), target(agentChatHome))
  },
})

export const seatsHeldRelayStatusVerb = defineVerb({
  name: 'seats.held-relay-status',
  description: 'launchd state of the held-relay job, or its systemd units on Linux',
  args: z.object({ agentChatHome: z.string().optional() }),
  result: Report,
  cli: { options: { agentChatHome: HOME_FLAG } },
  async run({ agentChatHome }) {
    return heldRelayStatusOn(systemHost(), target(agentChatHome))
  },
})
