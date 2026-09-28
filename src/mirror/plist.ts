import path from 'node:path'

/** The only variables a launchd job inherits; a token must never ride along from the caller's env. */
const PASSED_ENV = ['HOME', 'PATH', 'AGENT_CHAT_HOME'] as const

/** HOME and PATH always, AGENT_CHAT_HOME only when set; nothing else from `source`. */
export function jobEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of PASSED_ENV) {
    const value = source[key]
    if (value !== undefined && value !== '') env[key] = value
  }
  return env
}

/** Kept for existing call sites; identical to `jobEnv`. */
export const mirrorJobEnv = jobEnv

const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const stringTag = (value: string): string => `<string>${escapeXml(value)}</string>`

const keyString = (key: string, value: string, indent: string): string =>
  `${indent}<key>${escapeXml(key)}</key>\n${indent}${stringTag(value)}`

/** `KeepAlive` for a process that should stay up, or `StartInterval` for a periodic one. */
export type PlistSchedule =
  { kind: 'keep-alive'; throttleIntervalSeconds: number } | { kind: 'interval'; seconds: number }

interface PlistInput {
  label: string
  args: string[]
  logFile: string
  runAtLoad: boolean
  schedule: PlistSchedule
  env: Record<string, string>
}

const scheduleLines = (schedule: PlistSchedule): string[] =>
  schedule.kind === 'keep-alive'
    ? [
        '  <key>KeepAlive</key>\n  <true/>',
        `  <key>ThrottleInterval</key>\n  <integer>${schedule.throttleIntervalSeconds}</integer>`,
      ]
    : [`  <key>StartInterval</key>\n  <integer>${schedule.seconds}</integer>`]

/** Pure: the shared shape of every agent-chat launchd job. It holds no token. */
function renderPlist(input: PlistInput): string {
  const env = Object.entries(input.env).map(([key, value]) => keyString(key, value, '    '))
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    keyString('Label', input.label, '  '),
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...input.args.map(arg => `    ${stringTag(arg)}`),
    '  </array>',
    `  <key>RunAtLoad</key>\n  <${input.runAtLoad ? 'true' : 'false'}/>`,
    ...scheduleLines(input.schedule),
    keyString('StandardOutPath', input.logFile, '  '),
    keyString('StandardErrorPath', input.logFile, '  '),
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...env,
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

export interface MirrorPlistInput {
  label: string
  nodePath: string
  cliEntry: string
  logDir: string
  env: Record<string, string>
}

/** `agent-chat mirror run`, kept alive and throttled. */
export function renderMirrorPlist(input: MirrorPlistInput): string {
  return renderPlist({
    label: input.label,
    args: [input.nodePath, input.cliEntry, 'mirror', 'run'],
    logFile: path.join(input.logDir, 'mirror.log'),
    runAtLoad: true,
    schedule: { kind: 'keep-alive', throttleIntervalSeconds: 30 },
    env: input.env,
  })
}

export interface BurndownPlistInput {
  label: string
  nodePath: string
  cliEntry: string
  logDir: string
  env: Record<string, string>
  intervalSeconds: number
}

/** `agent-chat burndown tick --once` on a schedule; never kept alive between runs. */
export function renderBurndownPlist(input: BurndownPlistInput): string {
  return renderPlist({
    label: input.label,
    args: [input.nodePath, input.cliEntry, 'burndown', 'tick', '--once'],
    logFile: path.join(input.logDir, 'burndown.log'),
    runAtLoad: false,
    schedule: { kind: 'interval', seconds: input.intervalSeconds },
    env: input.env,
  })
}
