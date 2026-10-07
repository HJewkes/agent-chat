import path from 'node:path'

/** The only variables a launchd job inherits; a token must never ride along from the caller's env. */
const PASSED_ENV = ['HOME', 'PATH', 'AGENT_CHAT_HOME', 'ACTIVE_ROOT', 'AGENT_CHAT_ACTIVE_WORK_ROOT'] as const

/** HOME and PATH always, the home and active-work roots only when set; nothing else from `source`. */
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

/** Worktrees are parked (deleted) after merge, so a job pointing into one dies with MODULE_NOT_FOUND. */
const WORKTREE_SEGMENTS = [['.worktrees'], ['.claude', 'worktrees']] as const

/** macOS and POSIX scratch roots; the OS reaps them, so state homed there vanishes under the job. */
const SCRATCH_ROOTS = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders']

export interface JobPathsInput {
  nodePath: string
  cliEntry: string
  env: Record<string, string>
  tmpdir: string
}

function hasWorktreeSegment(file: string): boolean {
  const parts = path.normalize(file).split(path.sep)
  return WORKTREE_SEGMENTS.some(seg => parts.some((_, i) => seg.every((name, j) => parts[i + j] === name)))
}

function isInside(file: string, root: string): boolean {
  const rel = path.relative(path.normalize(root), path.normalize(file))
  return rel === '' || (rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel))
}

const inScratch = (file: string, tmpdir: string): boolean =>
  [tmpdir, ...SCRATCH_ROOTS].some(root => isInside(file, root))

/** Pure: why an explicitly named agent-chat home must not be baked into a job; empty when sound. */
export function agentChatHomeRefusals(home: string, tmpdir: string): string[] {
  if (inScratch(home, tmpdir)) return [`refused: --agent-chat-home ${home} is inside a temp dir`]
  if (hasWorktreeSegment(home)) return [`refused: --agent-chat-home ${home} is inside a worktree`]
  return []
}

/** Pure: why a launchd job built from these paths would break once the tree or scratch dir goes; empty when sound. */
export function launchdJobRefusals(input: JobPathsInput): string[] {
  const errors: string[] = []
  for (const [what, file] of [
    ['CLI entry', input.cliEntry],
    ['node path', input.nodePath],
  ] as const) {
    if (hasWorktreeSegment(file))
      errors.push(`refused: ${what} ${file} is inside a worktree; install from the main checkout`)
  }
  const home = input.env.AGENT_CHAT_HOME
  if (home !== undefined && inScratch(home, input.tmpdir))
    errors.push(
      `refused: AGENT_CHAT_HOME ${home} is inside a temp dir; unset it or point it at durable state`,
    )
  return errors
}

const escapeXml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const stringTag = (value: string): string => `<string>${escapeXml(value)}</string>`

const keyString = (key: string, value: string, indent: string): string =>
  `${indent}<key>${escapeXml(key)}</key>\n${indent}${stringTag(value)}`

/** `KeepAlive` for a process that should stay up, `StartInterval` for a periodic one, or fixed minutes past each hour. */
export type PlistSchedule =
  | { kind: 'keep-alive'; throttleIntervalSeconds: number }
  | { kind: 'interval'; seconds: number }
  | { kind: 'minutes'; minutes: readonly number[] }

/** One scheduled job, rendered as a launchd plist on darwin and as systemd units on Linux. */
export interface JobSpec {
  label: string
  args: string[]
  logFile: string
  runAtLoad: boolean
  schedule: PlistSchedule
  env: Record<string, string>
}

function scheduleLines(schedule: PlistSchedule): string[] {
  if (schedule.kind === 'keep-alive')
    return [
      '  <key>KeepAlive</key>\n  <true/>',
      `  <key>ThrottleInterval</key>\n  <integer>${schedule.throttleIntervalSeconds}</integer>`,
    ]
  if (schedule.kind === 'interval')
    return [`  <key>StartInterval</key>\n  <integer>${schedule.seconds}</integer>`]
  const entries = schedule.minutes.map(
    m => `    <dict>\n      <key>Minute</key>\n      <integer>${m}</integer>\n    </dict>`,
  )
  return ['  <key>StartCalendarInterval</key>', '  <array>', ...entries, '  </array>']
}

/** Pure: the shared shape of every agent-chat launchd job. It holds no token. */
export function renderPlist(input: JobSpec): string {
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
export function burndownJob(input: BurndownPlistInput): JobSpec {
  return {
    label: input.label,
    args: [input.nodePath, input.cliEntry, 'burndown', 'tick', '--once'],
    logFile: path.join(input.logDir, 'burndown.log'),
    runAtLoad: false,
    schedule: { kind: 'interval', seconds: input.intervalSeconds },
    env: input.env,
  }
}

export const renderBurndownPlist = (input: BurndownPlistInput): string => renderPlist(burndownJob(input))

export interface WatchdogPlistInput {
  label: string
  nodePath: string
  cliEntry: string
  logDir: string
  env: Record<string, string>
  minutes: readonly number[]
}

/** `agent-chat seats watchdog` at fixed minutes, so a replay's run times are the installed job's. */
export function watchdogJob(input: WatchdogPlistInput): JobSpec {
  return {
    label: input.label,
    args: [input.nodePath, input.cliEntry, 'seats', 'watchdog'],
    logFile: path.join(input.logDir, 'watchdog.log'),
    runAtLoad: false,
    schedule: { kind: 'minutes', minutes: input.minutes },
    env: input.env,
  }
}

export const renderWatchdogPlist = (input: WatchdogPlistInput): string => renderPlist(watchdogJob(input))
