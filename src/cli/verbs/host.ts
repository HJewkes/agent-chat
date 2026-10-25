import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import type { Command as Commander } from 'commander'
import { z } from 'zod'
import { jobNodePath } from '../../mirror/node-path.js'
import { jobEnv, launchdJobRefusals, renderPlist, type JobSpec } from '../../mirror/plist.js'
import { renderUnits, unitName } from '../../mirror/systemd-unit.js'
import { shellQuote } from '@titan-design/agent-surface'
import { assertMachineAlias, ensureBrokerKey, registerMachineAlias } from '../../broker/launcher-key.js'
import { cliEntry, launcherKeyPath, linuxJobLogDir, socketPath, systemdUserUnitDir } from '../../paths.js'
import type { HostLauncherInfo, ServerMessage } from '../../protocol.js'
import { defaultLauncherDeps, hostSurfaces, serveHost } from '../../server/host-launcher.js'
import { ago } from '../client.js'
import { addVerb, defineVerb, Report } from '../command.js'

export const HOST_LAUNCHER_LABEL = 'dev.hjewkes.agent-chat-host-launcher'

const hasTmux = (): boolean => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const HOST_FLAG = {
  long: '--host <name>',
  description: "the machine name to announce; defaults to this machine's hostname, as sessions report it",
}

export const hostServeVerb = defineVerb({
  name: 'host.serve',
  description:
    'run this machine as a host launcher (CC-951): announce it to the broker, answer its probes, and ' +
    'launch teleport successors here with the cwd and account the spec names; reconnects after a drop',
  args: z.object({ host: z.string().optional(), landing: z.string().optional() }),
  result: Report,
  cli: {
    options: {
      host: HOST_FLAG,
      landing: {
        long: '--landing <dir>',
        description:
          'where a successor lands when its cwd is missing on this machine (CC-1646); defaults to ~/agent-landing, ' +
          'and is announced only while it exists under home',
      },
    },
  },
  async run({ host, landing }) {
    const identity = {
      host: host ?? os.hostname(),
      platform: process.platform,
      surfaces: hostSurfaces(process.platform, hasTmux()),
      landing: path.resolve(landing ?? path.join(os.homedir(), 'agent-landing')),
    }
    const log = (line: string): void => console.log(`${new Date().toISOString()} host serve: ${line}`)
    return serveHost(socketPath(), identity, defaultLauncherDeps(os.homedir()), log)
  },
})

/** Pure: one line per connected launcher. */
export function renderHosts(hosts: readonly HostLauncherInfo[]): string[] {
  if (hosts.length === 0) return ['no host launchers connected']
  return hosts.map(h => `${h.host}  ${h.platform}  ${h.surfaces.join(',')}  connected ${ago(h.connectedAt)}`)
}

export const hostListVerb = defineVerb({
  name: 'host.list',
  description: 'the host launchers connected to the broker, with their platform and surfaces',
  args: z.object({}),
  result: Report,
  async run(_args, ctx) {
    const reply = (await ctx.withBroker(b => b.request({ t: 'hosts' }, 'hosts_result'))) as Extract<
      ServerMessage,
      { t: 'hosts_result' }
    >
    return { ok: true, lines: renderHosts(reply.hosts) }
  },
})

const darwinLogDir = (): string => path.join(os.homedir(), 'Library', 'Logs', 'agent-chat-host-launcher')
const plistPath = (): string =>
  path.join(os.homedir(), 'Library', 'LaunchAgents', `${HOST_LAUNCHER_LABEL}.plist`)

/** Pure: `host serve`, kept alive and throttled, under launchd on darwin and systemd --user on Linux. */
export function hostLauncherJob(input: {
  nodePath: string
  cliEntry: string
  logDir: string
  env: Record<string, string>
  host?: string | undefined
}): JobSpec {
  return {
    label: HOST_LAUNCHER_LABEL,
    args: [input.nodePath, input.cliEntry, 'host', 'serve', ...(input.host ? ['--host', input.host] : [])],
    logFile: path.join(input.logDir, 'host-launcher.log'),
    runAtLoad: true,
    schedule: { kind: 'keep-alive', throttleIntervalSeconds: 30 },
    env: input.env,
  }
}

export interface InstallTarget {
  platform: NodeJS.Platform
  uid: number
  nodePath: string
  cliEntry: string
  env: Record<string, string>
  host?: string | undefined
}

function linuxInstall(job: JobSpec, logDir: string): string[] {
  const units = renderUnits(job)
  const file = path.join(systemdUserUnitDir(), `${units.name}.service`)
  return [
    `# write to ${file}:`,
    units.service,
    '# then run:',
    `mkdir -p ${shellQuote(logDir)}`,
    'systemctl --user daemon-reload',
    `systemctl --user enable --now ${units.name}.service`,
  ]
}

function darwinInstall(job: JobSpec, logDir: string, uid: number): string[] {
  const file = plistPath()
  return [
    `# write to ${file}:`,
    renderPlist(job),
    '# then run:',
    `mkdir -p ${shellQuote(logDir)}`,
    `launchctl bootstrap gui/${uid} ${shellQuote(file)}`,
  ]
}

/**
 * Print-only: the unit or plist and the commands that would load it. Installing a login job is
 * the owner's step, so this writes nothing and loads nothing.
 */
export function hostInstallReport(target: InstallTarget): Report {
  const linux = target.platform === 'linux'
  const logDir = linux ? linuxJobLogDir(unitName(HOST_LAUNCHER_LABEL)) : darwinLogDir()
  const job = hostLauncherJob({ ...target, logDir })
  const errors = launchdJobRefusals({ ...target, tmpdir: os.tmpdir() })
  if (errors.length > 0) return { ok: false, lines: [], errors }
  return { ok: true, lines: linux ? linuxInstall(job, logDir) : darwinInstall(job, logDir, target.uid) }
}

export const hostInstallVerb = defineVerb({
  name: 'host.install',
  description:
    'print, without writing or loading anything, the kept-alive launchd plist (systemd --user unit on ' +
    'Linux) that runs `host serve`, and the commands that install it; the owner runs them',
  args: z.object({ host: z.string().optional() }),
  result: Report,
  cli: { options: { host: HOST_FLAG } },
  async run({ host }) {
    return hostInstallReport({
      platform: process.platform,
      uid: process.getuid?.() ?? 0,
      nodePath: jobNodePath(),
      cliEntry: cliEntry(),
      env: jobEnv(process.env),
      host,
    })
  },
})

/** Pure but for the key mint: never puts the key in the report, only where it is and how to pull it. */
export function hostKeyNewReport(host: string, alias: string | undefined, brokerHost: string): Report {
  try {
    const file = launcherKeyPath(host)
    if (alias !== undefined) assertMachineAlias(alias)
    ensureBrokerKey(host)
    if (alias !== undefined) registerMachineAlias(alias, host)
    const remote = path.relative(os.homedir(), file)
    return {
      ok: true,
      lines: [
        `launcher key: ${file}${alias === undefined ? '' : ` (alias ${alias.toLowerCase()})`}`,
        'on the launcher machine, pull it and restrict it:',
        `scp ${brokerHost}:${remote} ~/.agent-chat/launcher.key`,
        'chmod 600 ~/.agent-chat/launcher.key',
      ],
    }
  } catch (err) {
    return { ok: false, lines: [], errors: [err instanceof Error ? err.message : String(err)] }
  }
}

export const hostKeyNewVerb = defineVerb({
  name: 'host.key-new',
  description:
    'mint the broker-side launcher key for a host (idempotent) and optionally record a destination alias ' +
    'for it (CC-1646); prints the key path and the pull command for the launcher machine, never the key',
  args: z.object({ host: z.string(), alias: z.string().optional() }),
  result: Report,
  cli: {
    positional: ['host'],
    options: {
      alias: { long: '--alias <name>', description: 'destination name for agent_teleport, e.g. mac' },
    },
  },
  async run({ host, alias }) {
    return hostKeyNewReport(host, alias, os.hostname())
  },
})

export function addHostCommands(program: Commander): void {
  const host = program
    .command('host')
    .description('host launchers: machines a teleport can land a successor on')
  addVerb(host, hostServeVerb)
  addVerb(host, hostListVerb)
  addVerb(host, hostInstallVerb)
  addVerb(host, hostKeyNewVerb)
}
