import { cliEntry, home } from '../../paths.js'

/**
 * The one command every surface launches: `agent-chat run-agent <id>`.
 *
 * A surface never sees `plan.bin` or `plan.args`. The plan is already on disk and
 * `run-agent` is what reads it, which is what keeps a model-authored brief out of
 * every command line — AppleScript only ever carries a fixed string with an
 * 8-char id in it. See launch-files.ts for the longer version of this argument.
 */

export const runAgentArgv = (agentId: string): string[] => [cliEntry(), 'run-agent', agentId]

/** Single-quoted for /bin/sh: paths here are ours, but they can still hold spaces. */
const shellQuote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`

/**
 * For surfaces that hand a shell a line to type, rather than spawning argv directly.
 *
 * The home is carried EXPLICITLY, and it has to be. A headless agent is spawned
 * by the broker and inherits the broker's environment, so it finds its plan for
 * free; a pane is opened by AppleScript and runs in a fresh login shell that has
 * whatever the USER's profile sets — which is not the broker's home whenever
 * `AGENT_CHAT_HOME` has been relocated. Observed live, on the first real
 * teleport: the tab opened, `run-agent` resolved the default home, and died with
 * "no launch plan for agent 71aa68a5" while the plan sat in the relocated one.
 * This is not teleport-specific; every visible spawn had it.
 */
export const runAgentCommand = (agentId: string): string =>
  [
    `AGENT_CHAT_HOME=${shellQuote(home())}`,
    ...[process.execPath, ...runAgentArgv(agentId)].map(shellQuote),
  ].join(' ')
