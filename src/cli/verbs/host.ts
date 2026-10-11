import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import type { Command as Commander } from 'commander'
import { z } from 'zod'
import { launchdControl, systemHost, unitControl, usesSystemd, type JobHost } from '../../mirror/job-host.js'
import { startJob } from '../../mirror/launchd.js'
import { jobEnv, launchdJobRefusals, renderPlist, type JobSpec } from '../../mirror/plist.js'
import { installUnits } from '../../mirror/systemd.js'
import { renderUnits, unitName } from '../../mirror/systemd-unit.js'
import { cliEntry, linuxJobLogDir, socketPath } from '../../paths.js'
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

export function hostInstallOn(jobHost: JobHost, host?: string): Report {
  const linux = usesSystemd(jobHost)
  const logDir = linux ? linuxJobLogDir(unitName(HOST_LAUNCHER_LABEL)) : darwinLogDir()
  const job = hostLauncherJob({
    nodePath: process.execPath,
    cliEntry: cliEntry(),
    logDir,
    env: jobEnv(process.env),
    host,
  })
  const errors = launchdJobRefusals({
    ...job,
    nodePath: process.execPath,
    cliEntry: cliEntry(),
    tmpdir: os.tmpdir(),
  })
  if (errors.length > 0) return { ok: false, lines: [], errors }
  if (linux) {
    const units = renderUnits(job)
    const result = installUnits(unitControl(jobHost), units, logDir)
    return jobHost.dryRun ? { ok: true, lines: [units.service, ...result.lines] } : result
  }
  const plist = renderPlist(job)
  const result = startJob({ plist: plistPath(), logDir }, plist, launchdControl(jobHost, HOST_LAUNCHER_LABEL))
  return jobHost.dryRun ? { ok: true, lines: [plist, ...result.lines] } : result
}

export const hostInstallVerb = defineVerb({
  name: 'host.install',
  description:
    'install `host serve` as a kept-alive launchd job (systemd --user unit on Linux), so this machine ' +
    'stays a teleport destination across logins and broker restarts',
  args: z.object({ host: z.string().optional(), dryRun: z.boolean().optional() }),
  result: Report,
  cli: {
    options: {
      host: HOST_FLAG,
      dryRun: { long: '--dry-run', description: 'print the plist or unit and the calls; load nothing' },
    },
  },
  async run({ host, dryRun }) {
    return hostInstallOn(systemHost(dryRun === true), host)
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
