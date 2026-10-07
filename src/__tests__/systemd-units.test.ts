import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activeWorkRoot } from '../agents/active-work.js'
import { burndownInstallOn, burndownJobStatusOn, burndownUninstallOn } from '../cli/verbs/burndown-job.js'
import { watchdogInstallOn, watchdogStatusOn, watchdogUninstallOn } from '../cli/verbs/watchdog-job.js'
import type { JobHost } from '../mirror/job-host.js'
import type { Launchctl } from '../mirror/launchd.js'
import { burndownJob, jobEnv, watchdogJob, type JobSpec } from '../mirror/plist.js'
import type { Systemctl } from '../mirror/systemd.js'
import { quoteArg, renderUnits, unitName, unitNameForHome } from '../mirror/systemd-unit.js'
import { cliEntry, watchdogLogDir, watchdogPlistPath } from '../paths.js'

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
const savedEnv = {
  home: process.env.AGENT_CHAT_HOME,
  state: process.env.XDG_STATE_HOME,
  activeRoot: process.env.ACTIVE_ROOT,
  workRoot: process.env.AGENT_CHAT_ACTIVE_WORK_ROOT,
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-systemd-units-'))
  process.env.AGENT_CHAT_HOME = path.join(scratch, 'home')
  process.env.XDG_STATE_HOME = path.join(scratch, 'state')
  delete process.env.ACTIVE_ROOT
  delete process.env.AGENT_CHAT_ACTIVE_WORK_ROOT
})

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
  for (const [key, value] of [
    ['AGENT_CHAT_HOME', savedEnv.home],
    ['XDG_STATE_HOME', savedEnv.state],
    ['ACTIVE_ROOT', savedEnv.activeRoot],
    ['AGENT_CHAT_ACTIVE_WORK_ROOT', savedEnv.workRoot],
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
  beforeEach(() => {
    delete process.env.AGENT_CHAT_HOME
  })

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

const PILOT = '/srv/u/.agent-chat-pilot'
const PILOT_ROOT = '/srv/u/active-work-pilot'
const DEFAULT_HOME = path.join(os.homedir(), '.agent-chat')
const WATCHDOG = 'agent-chat-seat-watchdog'

const envLines = (): string[] => [
  `Environment="HOME=${process.env.HOME}"`,
  `Environment="PATH=${process.env.PATH}"`,
]

/** The watchdog service main renders with neither AGENT_CHAT_HOME nor ACTIVE_ROOT set. */
const mainService = (): string =>
  [
    '[Unit]',
    'Description=dev.hjewkes.agent-chat-seat-watchdog',
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${quoteArg(process.execPath)} ${quoteArg(cliEntry())} seats watchdog`,
    ...envLines(),
    `StandardOutput=append:${scratch}/state/${WATCHDOG}/watchdog.log`,
    `StandardError=append:${scratch}/state/${WATCHDOG}/watchdog.log`,
    '',
  ].join('\n')

const mainTimer = [
  '[Unit]',
  `Description=Schedule for ${WATCHDOG}.service`,
  '',
  '[Timer]',
  'OnCalendar=*-*-* *:08:00',
  'OnCalendar=*-*-* *:23:00',
  'OnCalendar=*-*-* *:38:00',
  'OnCalendar=*-*-* *:53:00',
  'AccuracySec=1s',
  '',
  '[Install]',
  'WantedBy=timers.target',
  '',
].join('\n')

const xml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The watchdog plist main renders with neither AGENT_CHAT_HOME nor ACTIVE_ROOT set. */
const mainPlist = (): string => {
  const minute = (m: number): string =>
    `    <dict>\n      <key>Minute</key>\n      <integer>${m}</integer>\n    </dict>`
  const log = path.join(watchdogLogDir(), 'watchdog.log')
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>\n  <string>dev.hjewkes.agent-chat-seat-watchdog</string>',
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${xml(process.execPath)}</string>`,
    `    <string>${xml(cliEntry())}</string>`,
    '    <string>seats</string>',
    '    <string>watchdog</string>',
    '  </array>',
    '  <key>RunAtLoad</key>\n  <false/>',
    '  <key>StartCalendarInterval</key>',
    '  <array>',
    ...[8, 23, 38, 53].map(minute),
    '  </array>',
    `  <key>StandardOutPath</key>\n  <string>${xml(log)}</string>`,
    `  <key>StandardErrorPath</key>\n  <string>${xml(log)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    `    <key>HOME</key>\n    <string>${xml(process.env.HOME ?? '')}</string>`,
    `    <key>PATH</key>\n    <string>${xml(process.env.PATH ?? '')}</string>`,
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

describe('watchdog home (CC-819)', () => {
  beforeEach(() => {
    delete process.env.AGENT_CHAT_HOME
  })

  it('passes ACTIVE_ROOT through the job env only when set and non-empty', () => {
    expect(jobEnv({ HOME: '/h', PATH: '/p', ACTIVE_ROOT: PILOT_ROOT, SECRET: 'x' })).toEqual({
      HOME: '/h',
      PATH: '/p',
      ACTIVE_ROOT: PILOT_ROOT,
    })
    expect(jobEnv({ HOME: '/h', PATH: '/p', ACTIVE_ROOT: '' })).toEqual({ HOME: '/h', PATH: '/p' })
  })

  it('names units after the base for the default home and suffixes any other home with its basename', () => {
    expect(unitNameForHome(WATCHDOG, DEFAULT_HOME, DEFAULT_HOME)).toBe(WATCHDOG)
    expect(unitNameForHome(WATCHDOG, PILOT, DEFAULT_HOME)).toBe(`${WATCHDOG}-pilot`)
    expect(unitNameForHome(WATCHDOG, '/data/my home!', DEFAULT_HOME)).toBe(`${WATCHDOG}-my_home_`)
    expect(unitNameForHome(WATCHDOG, '/elsewhere/.agent-chat', DEFAULT_HOME)).toBe(`${WATCHDOG}-agent-chat`)
  })

  it('renders the Linux units byte-identical to main when neither variable is set', () => {
    const { systemctl } = fakeSystemctl()
    const host = linuxHost(systemctl, true)
    const report = watchdogInstallOn(host)
    expect(report.lines[0]).toBe(mainService())
    expect(report.lines[1]).toBe(mainTimer)
    expect(report.lines[2]).toBe(`write ${unitFile(host, `${WATCHDOG}.service`)}`)
  })

  it('bakes a non-default shell home and ACTIVE_ROOT into suffixed Linux units', () => {
    process.env.AGENT_CHAT_HOME = PILOT
    process.env.ACTIVE_ROOT = PILOT_ROOT
    const { systemctl } = fakeSystemctl()
    const host = linuxHost(systemctl, true)
    const report = watchdogInstallOn(host)
    expect(report.lines[0]).toContain(
      `Environment="AGENT_CHAT_HOME=${PILOT}"\nEnvironment="ACTIVE_ROOT=${PILOT_ROOT}"\n`,
    )
    expect(report.lines[0]).toContain(`StandardOutput=append:${scratch}/state/${WATCHDOG}-pilot/watchdog.log`)
    expect(report.lines[1]).toContain(`Description=Schedule for ${WATCHDOG}-pilot.service`)
    expect(report.lines.slice(2)).toEqual([
      `write ${unitFile(host, `${WATCHDOG}-pilot.service`)}`,
      `write ${unitFile(host, `${WATCHDOG}-pilot.timer`)}`,
      'systemctl --user daemon-reload',
      `systemctl --user enable --now ${WATCHDOG}-pilot.timer`,
    ])
  })

  it('lets --agent-chat-home beat the shell AGENT_CHAT_HOME, resolved to an absolute path', () => {
    process.env.AGENT_CHAT_HOME = '/srv/u/.agent-chat-other'
    const { systemctl } = fakeSystemctl()
    const report = watchdogInstallOn(linuxHost(systemctl, true), {
      agentChatHome: '/srv/u/x/../.agent-chat-pilot',
    })
    expect(report.lines[0]).toContain(`Environment="AGENT_CHAT_HOME=${PILOT}"`)
    expect(report.lines[0]).not.toContain('agent-chat-other')
    expect(report.lines.at(-1)).toBe(`systemctl --user enable --now ${WATCHDOG}-pilot.timer`)
  })

  it('keeps the base names but bakes the home when the flag names the default home', () => {
    const { systemctl } = fakeSystemctl()
    const report = watchdogInstallOn(linuxHost(systemctl, true), { agentChatHome: DEFAULT_HOME })
    expect(report.lines[0]).toContain(`Environment="AGENT_CHAT_HOME=${DEFAULT_HOME}"`)
    expect(report.lines.at(-1)).toBe(`systemctl --user enable --now ${WATCHDOG}.timer`)
  })

  it.each([
    ['a temp dir', path.join(os.tmpdir(), 'pilot-home'), /is inside a temp dir/],
    ['a worktree', '/repo/.worktrees/cc-1/home', /is inside a worktree/],
  ])('refuses a --agent-chat-home inside %s, writing and calling nothing', (_, home, error) => {
    const { systemctl, calls } = fakeSystemctl()
    const host = linuxHost(systemctl)
    const report = watchdogInstallOn(host, { agentChatHome: home })
    expect(report.ok).toBe(false)
    expect(report.errors?.[0]).toMatch(error)
    expect(calls).toEqual([])
    expect(fs.existsSync(host.unitDir)).toBe(false)
  })

  it('uninstalls and reports the suffixed units the flag names', () => {
    const { systemctl, calls } = fakeSystemctl('LoadState=not-found\n')
    const host = linuxHost(systemctl)
    watchdogInstallOn(host, { agentChatHome: PILOT })
    calls.length = 0
    expect(watchdogUninstallOn(host, { agentChatHome: PILOT }).ok).toBe(true)
    expect(calls).toEqual([`--user disable --now ${WATCHDOG}-pilot.timer`, '--user daemon-reload'])
    expect(fs.readdirSync(host.unitDir)).toEqual([])
    expect(watchdogStatusOn(host, { agentChatHome: PILOT }).lines).toEqual([
      `systemd ${WATCHDOG}-pilot.service not loaded`,
      `systemd ${WATCHDOG}-pilot.timer not loaded`,
    ])
  })

  it('carries ACTIVE_ROOT alone into the unit, where it moves the active-work root to the pilot', () => {
    process.env.ACTIVE_ROOT = PILOT_ROOT
    const { systemctl } = fakeSystemctl()
    const service = watchdogInstallOn(linuxHost(systemctl, true)).lines[0] ?? ''
    expect(service).toContain(`Environment="ACTIVE_ROOT=${PILOT_ROOT}"`)
    expect(service).not.toContain('AGENT_CHAT_ACTIVE_WORK_ROOT')
    expect(rootUnder(unitEnv(service))).toBe(PILOT_ROOT)
  })

  it('carries AGENT_CHAT_ACTIVE_WORK_ROOT into the unit, where it beats ACTIVE_ROOT', () => {
    process.env.ACTIVE_ROOT = '/srv/u/active-work-other'
    process.env.AGENT_CHAT_ACTIVE_WORK_ROOT = PILOT_ROOT
    const { systemctl } = fakeSystemctl()
    const service = watchdogInstallOn(linuxHost(systemctl, true)).lines[0] ?? ''
    expect(service).toContain(`Environment="AGENT_CHAT_ACTIVE_WORK_ROOT=${PILOT_ROOT}"`)
    expect(rootUnder(unitEnv(service))).toBe(PILOT_ROOT)
  })

  it('resolves the default active-work root when neither variable is set', () => {
    const expected =
      process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support', 'active-work')
        : path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'active-work')
    expect(activeWorkRoot()).toBe(expected)
  })

  it('refuses an empty --agent-chat-home rather than resolving it to the cwd', () => {
    const { systemctl, calls } = fakeSystemctl()
    const report = watchdogInstallOn(linuxHost(systemctl), { agentChatHome: '' })
    expect(report.ok).toBe(false)
    expect(report.errors).toEqual(['refused: --agent-chat-home is empty'])
    expect(calls).toEqual([])
  })

  it('falls back to a hash token when the basename would push the unit name past 255 characters', () => {
    const name = unitNameForHome(WATCHDOG, `/srv/u/${'p'.repeat(240)}`, DEFAULT_HOME)
    expect(name).toMatch(new RegExp(`^${WATCHDOG}-[0-9a-f]{8}$`))
    expect(`${unitNameForHome(WATCHDOG, `/srv/u/${'p'.repeat(222)}`, DEFAULT_HOME)}.service`).toHaveLength(
      255,
    )
  })

  it('renders the darwin plist byte-identical to main when neither variable is set', () => {
    const { launchctl } = fakeLaunchctl()
    expect(watchdogInstallOn(darwinHost(launchctl, true)).lines[0]).toBe(mainPlist())
  })

  it('keeps the darwin label and plist path on every home input', () => {
    process.env.AGENT_CHAT_HOME = '/srv/u/.agent-chat-other'
    process.env.ACTIVE_ROOT = PILOT_ROOT
    const target = { agentChatHome: PILOT }
    const { launchctl, calls } = fakeLaunchctl()
    const report = watchdogInstallOn(darwinHost(launchctl, true), target)
    expect(report.lines[0]).toContain('<string>dev.hjewkes.agent-chat-seat-watchdog</string>')
    expect(report.lines).toContain(`launchctl bootstrap gui/501 ${watchdogPlistPath()}`)
    calls.length = 0
    watchdogUninstallOn(darwinHost(launchctl), target)
    const service = 'gui/501/dev.hjewkes.agent-chat-seat-watchdog'
    expect(calls).toEqual([`print ${service}`, `bootout ${service}`, `disable ${service}`])
    expect(watchdogStatusOn(darwinHost(launchctl), target).lines[1]).toBe(`plist ${watchdogPlistPath()}`)
  })
})

/** The `Environment=` pairs of a rendered service, unescaped for the plain values these tests use. */
function unitEnv(service: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const match of service.matchAll(/^Environment="([^=]+)=(.*)"$/gm)) env[match[1] ?? ''] = match[2] ?? ''
  return env
}

/** `activeWorkRoot()` as a job started with exactly `env` would resolve it. */
function rootUnder(env: Record<string, string>): string {
  const keys = ['ACTIVE_ROOT', 'AGENT_CHAT_ACTIVE_WORK_ROOT'] as const
  const saved = keys.map(key => process.env[key])
  for (const key of keys) {
    if (env[key] === undefined) delete process.env[key]
    else process.env[key] = env[key]
  }
  try {
    return activeWorkRoot()
  } finally {
    keys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key]
      else process.env[key] = saved[i]
    })
  }
}
