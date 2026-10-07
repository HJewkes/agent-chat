import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { burndownInstallOn, burndownJobStatusOn, burndownUninstallOn } from '../cli/verbs/burndown-job.js'
import { watchdogInstallOn, watchdogStatusOn, watchdogUninstallOn } from '../cli/verbs/watchdog-job.js'
import type { JobHost } from '../mirror/job-host.js'
import type { Launchctl } from '../mirror/launchd.js'
import { burndownJob, watchdogJob, type JobSpec } from '../mirror/plist.js'
import type { Systemctl } from '../mirror/systemd.js'
import { quoteArg, renderUnits, unitName } from '../mirror/systemd-unit.js'

const ENV = { HOME: '/srv/u', PATH: '/srv/u/.local/bin:/usr/bin' }

describe('renderUnits', () => {
  it('maps StartInterval to a oneshot service and a boot-relative repeating timer', () => {
    const units = renderUnits(
      burndownJob({
        label: 'dev.hjewkes.agent-chat-burndown',
        nodePath: '/opt/node/bin/node',
        cliEntry: '/repo/dist/cli.js',
        logDir: '/srv/u/.local/state/agent-chat-burndown',
        env: ENV,
        intervalSeconds: 600,
      }),
    )
    expect(units.name).toBe('agent-chat-burndown')
    expect(units.service).toBe(
      [
        '[Unit]',
        'Description=dev.hjewkes.agent-chat-burndown',
        '',
        '[Service]',
        'Type=oneshot',
        'ExecStart=/opt/node/bin/node /repo/dist/cli.js burndown tick --once',
        'Environment="HOME=/srv/u"',
        'Environment="PATH=/srv/u/.local/bin:/usr/bin"',
        'StandardOutput=append:/srv/u/.local/state/agent-chat-burndown/burndown.log',
        'StandardError=append:/srv/u/.local/state/agent-chat-burndown/burndown.log',
        '',
      ].join('\n'),
    )
    expect(units.timer).toBe(
      [
        '[Unit]',
        'Description=Schedule for agent-chat-burndown.service',
        '',
        '[Timer]',
        'OnBootSec=600s',
        'OnUnitActiveSec=600s',
        'AccuracySec=1s',
        '',
        '[Install]',
        'WantedBy=timers.target',
        '',
      ].join('\n'),
    )
  })

  it('maps fixed minutes past each hour to one OnCalendar line per minute', () => {
    const units = renderUnits(
      watchdogJob({
        label: 'dev.hjewkes.agent-chat-seat-watchdog',
        nodePath: '/opt/node/bin/node',
        cliEntry: '/repo/dist/cli.js',
        logDir: '/logs',
        env: {},
        minutes: [8, 23, 38, 53],
      }),
    )
    expect(units.name).toBe('agent-chat-seat-watchdog')
    expect(units.service).toContain('ExecStart=/opt/node/bin/node /repo/dist/cli.js seats watchdog\n')
    expect(units.service).not.toContain('[Install]')
    expect(units.timer).toContain(
      '[Timer]\nOnCalendar=*-*-* *:08:00\nOnCalendar=*-*-* *:23:00\nOnCalendar=*-*-* *:38:00\nOnCalendar=*-*-* *:53:00\n',
    )
  })

  it('maps KeepAlive to an always-restarting service wanted by default.target, with no timer', () => {
    const spec: JobSpec = {
      label: 'dev.hjewkes.agent-chat-mirror',
      args: ['/opt/node', '/repo/dist/cli.js', 'mirror', 'run'],
      logFile: '/logs/mirror.log',
      runAtLoad: true,
      schedule: { kind: 'keep-alive', throttleIntervalSeconds: 30 },
      env: {},
    }
    const units = renderUnits(spec)
    expect(units.timer).toBeUndefined()
    expect(units.service).toContain('[Service]\nType=simple\nRestart=always\nRestartSec=30\n')
    expect(units.service.endsWith('[Install]\nWantedBy=default.target\n')).toBe(true)
  })

  it('quotes an ExecStart path holding a space and escapes specifiers in the environment', () => {
    const units = renderUnits(
      watchdogJob({
        label: 'x',
        nodePath: '/Applications/My Node/node',
        cliEntry: '/repo/dist/cli.js',
        logDir: '/logs',
        env: { AGENT_CHAT_HOME: '/data/100% "real"' },
        minutes: [8],
      }),
    )
    expect(units.service).toContain('ExecStart="/Applications/My Node/node" /repo/dist/cli.js seats watchdog')
    expect(units.service).toContain('Environment="AGENT_CHAT_HOME=/data/100%% \\"real\\""')
  })

  it('escapes $ and % in a bare argument and leaves a plain one untouched', () => {
    expect(quoteArg('/a/$HOME/50%')).toBe('/a/$$HOME/50%%')
    expect(quoteArg('/plain/path')).toBe('/plain/path')
    expect(quoteArg('a\\b')).toBe('"a\\\\b"')
  })

  it('names units by dropping the reverse-DNS label prefix', () => {
    expect(unitName('dev.hjewkes.agent-chat-seat-watchdog')).toBe('agent-chat-seat-watchdog')
    expect(unitName('other')).toBe('other')
  })
})

let scratch: string
const savedEnv = { home: process.env.AGENT_CHAT_HOME, state: process.env.XDG_STATE_HOME }

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-systemd-units-'))
  process.env.AGENT_CHAT_HOME = path.join(scratch, 'home')
  process.env.XDG_STATE_HOME = path.join(scratch, 'state')
})

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
  for (const [key, value] of [
    ['AGENT_CHAT_HOME', savedEnv.home],
    ['XDG_STATE_HOME', savedEnv.state],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

/** Records each systemctl call and answers `show` with `shown`; never touches a real user manager. */
function fakeSystemctl(shown = ''): { systemctl: Systemctl; calls: string[] } {
  const calls: string[] = []
  const systemctl: Systemctl = args => {
    calls.push(args.join(' '))
    return { code: 0, stdout: args[1] === 'show' ? shown : '', stderr: '' }
  }
  return { systemctl, calls }
}

const noLaunchctl: Launchctl = () => {
  throw new Error('launchctl must not be called on Linux')
}

const noSystemctl: Systemctl = () => {
  throw new Error('systemctl must not be called on darwin')
}

function linuxHost(systemctl: Systemctl, dryRun = false): JobHost {
  const unitDir = path.join(scratch, 'systemd', 'user')
  return { platform: 'linux', launchctl: noLaunchctl, systemctl, uid: 1000, unitDir, dryRun }
}

const unitFile = (host: JobHost, file: string): string => path.join(host.unitDir, file)

describe('watchdog on Linux', () => {
  it('dry-runs by printing both units and the systemctl calls, writing and calling nothing', () => {
    const { systemctl, calls } = fakeSystemctl()
    const host = linuxHost(systemctl, true)
    const report = watchdogInstallOn(host)
    expect(report.ok).toBe(true)
    expect(report.lines[0]).toMatch(/^\[Unit\]\nDescription=dev\.hjewkes\.agent-chat-seat-watchdog\n/)
    expect(report.lines[1]).toContain('OnCalendar=*-*-* *:08:00')
    expect(report.lines.slice(2)).toEqual([
      `write ${unitFile(host, 'agent-chat-seat-watchdog.service')}`,
      `write ${unitFile(host, 'agent-chat-seat-watchdog.timer')}`,
      'systemctl --user daemon-reload',
      'systemctl --user enable --now agent-chat-seat-watchdog.timer',
    ])
    expect(calls).toEqual([])
    expect(fs.existsSync(host.unitDir)).toBe(false)
  })

  it('writes the units and log dir, reloads, and enables the timer; a changed unit restarts it', () => {
    const { systemctl, calls } = fakeSystemctl()
    const host = linuxHost(systemctl)
    expect(watchdogInstallOn(host).ok).toBe(true)
    expect(calls).toEqual(['--user daemon-reload', '--user enable --now agent-chat-seat-watchdog.timer'])
    expect(fs.readFileSync(unitFile(host, 'agent-chat-seat-watchdog.timer'), 'utf8')).toContain('[Timer]')
    expect(fs.existsSync(path.join(scratch, 'state', 'agent-chat-seat-watchdog'))).toBe(true)

    fs.writeFileSync(unitFile(host, 'agent-chat-seat-watchdog.service'), 'stale')
    calls.length = 0
    const report = watchdogInstallOn(host)
    expect(report.lines[0]).toBe(`rewrite ${unitFile(host, 'agent-chat-seat-watchdog.service')}`)
    expect(calls.at(-1)).toBe('--user restart agent-chat-seat-watchdog.timer')
  })

  it('uninstalls by disabling the timer, removing both units and reloading', () => {
    const { systemctl, calls } = fakeSystemctl()
    const host = linuxHost(systemctl)
    watchdogInstallOn(host)
    calls.length = 0
    expect(watchdogUninstallOn(host).ok).toBe(true)
    expect(calls).toEqual(['--user disable --now agent-chat-seat-watchdog.timer', '--user daemon-reload'])
    expect(fs.readdirSync(host.unitDir)).toEqual([])
  })

  it('reports each unit from systemctl show, with the next elapse for the timer', () => {
    const shown =
      'LoadState=loaded\nActiveState=active\nSubState=waiting\nNextElapseUSecRealtime=Tue 2026-10-06 10:08:00 UTC\n'
    const { systemctl, calls } = fakeSystemctl(shown)
    const report = watchdogStatusOn(linuxHost(systemctl))
    expect(report.lines[1]).toBe(
      'systemd agent-chat-seat-watchdog.timer active (waiting), next Tue 2026-10-06 10:08:00 UTC',
    )
    expect(calls[0]).toBe(
      '--user show agent-chat-seat-watchdog.service --property=LoadState,ActiveState,SubState,NextElapseUSecRealtime',
    )
  })

  it('reports a unit systemd does not know as not loaded', () => {
    const { systemctl } = fakeSystemctl('LoadState=not-found\nActiveState=inactive\nSubState=dead\n')
    expect(watchdogStatusOn(linuxHost(systemctl)).lines).toEqual([
      'systemd agent-chat-seat-watchdog.service not loaded',
      'systemd agent-chat-seat-watchdog.timer not loaded',
    ])
  })
})

/** Answers `print` as a loaded launchd job would. */
function fakeLaunchctl(): { launchctl: Launchctl; calls: string[] } {
  const calls: string[] = []
  const launchctl: Launchctl = args => {
    calls.push(args.join(' '))
    return args[0] === 'print'
      ? { code: 0, stdout: '\tpid = 4242\n', stderr: '' }
      : { code: 0, stdout: '', stderr: '' }
  }
  return { launchctl, calls }
}

const darwinHost = (launchctl: Launchctl, dryRun = false): JobHost => ({
  platform: 'darwin',
  launchctl,
  systemctl: noSystemctl,
  uid: 501,
  unitDir: path.join(scratch, 'unused'),
  dryRun,
})

describe('watchdog on darwin', () => {
  const service = 'gui/501/dev.hjewkes.agent-chat-seat-watchdog'

  it('dry-runs the launchd plist and never reaches systemctl', () => {
    const { launchctl } = fakeLaunchctl()
    const report = watchdogInstallOn(darwinHost(launchctl, true))
    expect(report.lines[0]).toContain('<plist version="1.0">')
  })

  it('uninstalls and reports through launchctl', () => {
    const { launchctl, calls } = fakeLaunchctl()
    watchdogUninstallOn(darwinHost(launchctl))
    expect(calls).toEqual([`print ${service}`, `bootout ${service}`, `disable ${service}`])
    expect(watchdogStatusOn(darwinHost(launchctl)).lines[0]).toBe('launchd loaded, pid 4242')
  })
})

describe('burndown job', () => {
  it('refuses a Linux install with the checklist while the config is not enabled, calling nothing', () => {
    const { systemctl, calls } = fakeSystemctl()
    const report = burndownInstallOn(linuxHost(systemctl, true))
    expect(report.ok).toBe(false)
    expect(report.lines[0]).toMatch(/Sign-off checklist/)
    expect(calls).toEqual([])
  })

  it('uninstalls the Linux timer and reports its units with the config state', () => {
    const { systemctl, calls } = fakeSystemctl('LoadState=loaded\nActiveState=active\nSubState=waiting\n')
    const host = linuxHost(systemctl)
    burndownUninstallOn(host)
    expect(calls[0]).toBe('--user disable --now agent-chat-burndown.timer')
    expect(burndownJobStatusOn(host).lines).toEqual([
      'systemd agent-chat-burndown.service active (waiting)',
      'systemd agent-chat-burndown.timer active (waiting)',
      'config enabled=false paused=false',
    ])
  })

  it('keeps darwin on launchctl', () => {
    const { launchctl, calls } = fakeLaunchctl()
    expect(burndownJobStatusOn(darwinHost(launchctl)).lines[0]).toBe('launchd loaded, pid 4242')
    burndownUninstallOn(darwinHost(launchctl))
    expect(calls.at(-1)).toBe('disable gui/501/dev.hjewkes.agent-chat-burndown')
  })
})
