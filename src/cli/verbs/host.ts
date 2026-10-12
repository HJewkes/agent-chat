import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import type { Command as Commander } from 'commander'
import { z } from 'zod'
import { jobNodePath } from '../../mirror/node-path.js'
import { jobEnv, launchdJobRefusals, renderPlist, type JobSpec } from '../../mirror/plist.js'
import { renderUnits, unitName } from '../../mirror/systemd-unit.js'
import { shellQuote } from '@titan-design/agent-surface'
import { cliEntry, linuxJobLogDir, socketPath, systemdUserUnitDir } from '../../paths.js'
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
  args: z.object({ host: z.string().optional() }),
  result: Report,
  cli: { options: { host: HOST_FLAG } },
  async run({ host }) {
    const identity = {
      host: host ?? os.hostname(),
      platform: process.platform,
      surfaces: hostSurfaces(process.platform, hasTmux()),
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

export function addHostCommands(program: Commander): void {
  const host = program
    .command('host')
    .description('host launchers: machines a teleport can land a successor on')
  addVerb(host, hostServeVerb)
  addVerb(host, hostListVerb)
  addVerb(host, hostInstallVerb)
}
