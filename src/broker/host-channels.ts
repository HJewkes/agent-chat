import { execFileSync } from 'node:child_process'
import { EFFORT_LEVELS, type EffortLevel } from '../agents/types.js'

/**
 * Whether the Claude Code process hosting a session can actually receive a
 * channel push.
 *
 * This exists because the transport cannot tell us. Claude Code decides which
 * servers may push from its `--channels` flag alone, and it enforces that at
 * RECEIPT: a notification from a server not on the list is dropped client-side
 * ("server … not in --channels list for this session"). The broker's write
 * still succeeds, so `chat_send` reports `delivered` for a message nobody will
 * ever see. Sessions have sat for hours accumulating hundreds of undelivered
 * messages this way — CC-73.
 *
 * The one thing the broker does hold is `hostPid`, which register already
 * carries. Reading that process's argv is therefore the only honest answer
 * available, and it is a READ: nothing here signals the host.
 */

/**
 * `unknown` is not a failure — it means we could not look, so callers must not treat it as "no".
 * `print` is a `claude -p` host: it drops every push whatever its `--channels` says (CC-1455).
 */
export type ChannelStatus = 'yes' | 'no' | 'unknown' | 'print'

const CHANNEL_FLAGS = ['--channels', '--dangerously-load-development-channels']

const PRINT_FLAGS = ['-p', '--print']

/** Whether an argv runs Claude Code in print mode; stops at `--`, so a prompt holding `-p` is not one. */
export function printModeFromArgv(argv: readonly string[]): boolean {
  for (const token of argv) {
    if (token === '--') return false
    if (PRINT_FLAGS.includes(token)) return true
  }
  return false
}

/**
 * True when `token` names this server.
 *
 * Accepts the three spellings a target can take: a bare server name, the
 * explicit `server:` form, and `plugin:<name>@<marketplace>` — where the
 * marketplace varies by install and must not be part of the test.
 */
function namesAgentChat(token: string, server: string): boolean {
  if (token === server || token === `server:${server}`) return true
  if (!token.startsWith('plugin:')) return false
  return token.slice('plugin:'.length).split('@')[0] === server
}

/**
 * Decide from a host's argv whether `server` was allowed to push to it.
 *
 * Pure so the decision is testable without a process to inspect. Takes argv
 * already split into tokens: the caller owns the quoting problem, and a prompt
 * containing the word `--channels` must not be able to fake a verdict — hence
 * scanning for the flag rather than a substring match on the whole line.
 */
export function channelStatusFromArgv(argv: readonly string[], server = 'agent-chat'): ChannelStatus {
  if (printModeFromArgv(argv)) return 'print'
  for (let i = 0; i < argv.length; i++) {
    // Everything past a bare `--` is an operand, so a `--channels` there is part
    // of the prompt and grants nothing. Checked before the flag test so a prompt
    // cannot talk this function into reporting a channel the host does not have.
    if (argv[i] === '--') break
    if (!CHANNEL_FLAGS.includes(argv[i]!)) continue
    // The flag is variadic: every following token up to the next flag is a
    // target. `--` ends the option section entirely, so stop there too.
    for (let j = i + 1; j < argv.length; j++) {
      const token = argv[j]!
      if (token === '--' || token.startsWith('-')) break
      if (namesAgentChat(token, server)) return 'yes'
    }
  }
  // No flag naming this server is a real answer, not a missing one: the flag is
  // the only way to opt in, so its absence means pushes will be dropped.
  // `unknown` is reserved for the case where the argv could not be read at all.
  return 'no'
}

/** Injected so the decision is testable without a live process to inspect. */
export type ArgvReader = (pid: number) => string | undefined

/**
 * Read a process's command line. `undefined` when it cannot be read — the
 * process is gone, or belongs to another user — which must surface as `unknown`
 * rather than `no`, since "we could not look" is not evidence of absence.
 */
export const psArgvReader: ArgvReader = pid => {
  try {
    // `-ww` defeats the default width truncation, which would otherwise cut the
    // flag off a long command line and silently produce a false `no`.
    const out = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const line = out.trim()
    return line === '' ? undefined : line
  } catch {
    return undefined
  }
}

/**
 * Whether the Claude Code process at `pid` can receive a push from `server`.
 *
 * KNOWN LIMIT, and it is a property of the platform rather than of this code:
 * `ps` reports a command line already joined by spaces, so the original argument
 * boundaries are gone and a prompt is indistinguishable from a run of separate
 * tokens. A session whose PROMPT contains the literal sequence
 * `--channels agent-chat`, launched without a `--` separator, therefore reads as
 * `yes` when it is really `no`. That is the pre-CC-73 behaviour for one rare
 * case, not a new failure — and the reverse error, reporting `no` for a session
 * that can in fact receive, is not reachable this way.
 */
export function hostChannelStatus(
  pid: number | undefined,
  server = 'agent-chat',
  read: ArgvReader = psArgvReader,
): ChannelStatus {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1) return 'unknown'
  const line = read(pid)
  if (line === undefined) return 'unknown'
  return channelStatusFromArgv(line.split(/\s+/), server)
}

/** Whether an argv started Remote Control; stops at `--` so a prompt naming the flag grants nothing. */
export function remoteControlFromArgv(argv: readonly string[]): boolean {
  for (const token of argv) {
    if (token === '--') return false
    if (token === '--remote-control' || token.startsWith('--remote-control=')) return true
  }
  return false
}

/**
 * Whether the Claude Code process at `pid` was launched with `--remote-control` (H-12).
 * `undefined` when the argv cannot be read, which callers must not read as "no".
 * A session that enabled it later with `/remote-control` does not show here.
 */
export function hostRemoteControl(
  pid: number | undefined,
  read: ArgvReader = psArgvReader,
): boolean | undefined {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1) return undefined
  const line = read(pid)
  return line === undefined ? undefined : remoteControlFromArgv(line.split(/\s+/))
}

/** CC-951: the permission modes a successor may inherit; a bypass never crosses a teleport. */
export const CARRIED_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto'] as const

export type CarriedPermissionMode = (typeof CARRIED_PERMISSION_MODES)[number]

/** CC-951: the launch flags, beyond Remote Control, a teleport successor inherits from its predecessor's argv. */
export interface CarriedFlags {
  /** Every `--channels` target except agent-chat's own, which every launch already adds. */
  channels: string[]
  permissionMode?: CarriedPermissionMode
  effort?: EffortLevel
  /** CC-1166: an adopted predecessor's model, for when the broker cannot read its transcript. */
  model?: string
}

const CHANNEL_TOKEN = /^(plugin:[A-Za-z0-9._-]+@[A-Za-z0-9._-]+|server:[A-Za-z0-9._-]+)$/

/** A channel target a launch may pass on: never a flag, never a bare word Claude Code would guess at. */
export const isChannelToken = (token: string): boolean => CHANNEL_TOKEN.test(token)

const isEffort = (level: string): level is EffortLevel => (EFFORT_LEVELS as readonly string[]).includes(level)

const MODEL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,79}$/

/** CC-1166: a model id a launch may pass on, `[1m]`-style suffixes included; never a flag. */
export const isCarriedModel = (model: string): boolean => MODEL_TOKEN.test(model)

export const isCarriedPermissionMode = (mode: string): mode is CarriedPermissionMode =>
  (CARRIED_PERMISSION_MODES as readonly string[]).includes(mode)

/** `--flag value` and `--flag=value` both, the first only when the next token is not itself a flag. */
function flagValue(argv: readonly string[], i: number, flag: string): string | undefined {
  const token = argv[i]!
  if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1)
  if (token !== flag) return undefined
  const next = argv[i + 1]
  return next === undefined || next.startsWith('-') ? undefined : next
}

/** The variadic targets after a `--channels` at `i`, up to the next flag or `--`. */
function channelTargets(argv: readonly string[], i: number): string[] {
  const targets: string[] = []
  for (let j = i + 1; j < argv.length && !argv[j]!.startsWith('-'); j++) targets.push(argv[j]!)
  return targets
}

/**
 * CC-951: what a successor carries from its predecessor's argv. Stops at `--` so a prompt
 * naming a flag carries nothing, and keeps only values a launch can pass on safely. Remote
 * Control has its own reader above, since a coordinator seat keeps it whatever its argv says.
 */
export function carriedFlagsFromArgv(argv: readonly string[], server = 'agent-chat'): CarriedFlags {
  const end = argv.indexOf('--')
  const options = end < 0 ? argv : argv.slice(0, end)
  const channels: string[] = []
  let permissionMode: CarriedPermissionMode | undefined
  let effort: EffortLevel | undefined
  let model: string | undefined
  options.forEach((token, i) => {
    if (token === '--channels') channels.push(...channelTargets(options, i))
    const mode = flagValue(options, i, '--permission-mode')
    if (mode !== undefined && isCarriedPermissionMode(mode)) permissionMode = mode
    const level = flagValue(options, i, '--effort')
    if (level !== undefined && isEffort(level)) effort = level
    const named = flagValue(options, i, '--model')
    if (named !== undefined && isCarriedModel(named)) model = named
  })
  return {
    channels: [...new Set(channels)].filter(t => isChannelToken(t) && !namesAgentChat(t, server)),
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(effort === undefined ? {} : { effort }),
    ...(model === undefined ? {} : { model }),
  }
}

/** CC-951: the flags the Claude Code at `pid` was launched with; `undefined` when its argv cannot be read. */
export function hostCarriedFlags(
  pid: number | undefined,
  read: ArgvReader = psArgvReader,
): CarriedFlags | undefined {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1) return undefined
  const line = read(pid)
  return line === undefined ? undefined : carriedFlagsFromArgv(line.split(/\s+/))
}

/** CC-951: a caller-reported `launchSeen`, kept only where every value passes the same checks as a local read. */
export function sanitizeCarried(raw: unknown): CarriedFlags | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { channels, permissionMode, effort, model } = raw as Record<string, unknown>
  const tokens = Array.isArray(channels) ? channels.filter((t): t is string => typeof t === 'string') : []
  return {
    channels: [...new Set(tokens)].filter(t => isChannelToken(t) && !namesAgentChat(t, 'agent-chat')),
    ...(typeof permissionMode === 'string' && isCarriedPermissionMode(permissionMode)
      ? { permissionMode }
      : {}),
    ...(typeof effort === 'string' && isEffort(effort) ? { effort } : {}),
    ...(typeof model === 'string' && isCarriedModel(model) ? { model } : {}),
  }
}
