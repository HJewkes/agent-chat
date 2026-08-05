import { execFileSync } from 'node:child_process'

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

/** `unknown` is not a failure — it means we could not look, so callers must not treat it as "no". */
export type ChannelStatus = 'yes' | 'no' | 'unknown'

const CHANNEL_FLAGS = ['--channels', '--dangerously-load-development-channels']

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
