import path from 'node:path'
import { agentDir, cliEntry, home } from '../../paths.js'

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

/**
 * One word of iTerm2's `command` parameter, which iTerm splits into argv itself
 * (`componentsInShellCommand`), with no shell and its own escape rules: `\n`,
 * `\t`, `\a` and `\r` become control characters even inside single quotes, and
 * the string is first evaluated as an interpolated "swifty" string where `\(`
 * starts an expression. So a word is double-quoted and may hold no backslash
 * and no double quote at all, rather than trusting an escape to survive both.
 */
const itermWord = (word: string): string => {
  if (/["\\]/.test(word))
    throw new Error(`cannot hand iTerm2 a command containing a double quote or backslash: ${word}`)
  return `"${word}"`
}

/**
 * For a pane the broker opens (CC-175): the command is given to iTerm at
 * creation, so it is never typed into a shell whose input the human can reach.
 *
 * `zsh -lic` for the environment a typed command used to get: `-l` for PATH from
 * .zprofile, `-i` for whatever .zshrc exports. `exec /bin/zsh -l` afterwards
 * keeps the pane, and whatever run-agent printed, open after it exits or crashes.
 */
export const paneCommand = (agentId: string): string =>
  ['/bin/zsh', '-lic', `${runAgentCommand(agentId)}; exec /bin/zsh -l`].map(itermWord).join(' ')

/** Where teleport's in-place relaunch lives: in the agent's own 0700 dir, beside its plan. */
export const relaunchScriptPath = (agentId: string): string => path.join(agentDir(agentId), 'relaunch')

/**
 * The only thing still typed into a shell (CC-191): a reused pane has no creation
 * `command` to take, so teleport types this short fixed path instead of the full
 * command line. Keys that join it in front make it a different, failing command;
 * keys typed between it and the newline become arguments, which a correct
 * invocation never has.
 */
export const relaunchCommand = (agentId: string): string => shellQuote(relaunchScriptPath(agentId))

export const relaunchScript = (agentId: string): string =>
  [
    '#!/bin/sh',
    'if [ "$#" -ne 0 ]; then',
    `  echo "agent-chat: not relaunching ${agentId}: typed keys joined the command (extra arguments: $*)" >&2`,
    '  exit 64',
    'fi',
    `export AGENT_CHAT_HOME=${shellQuote(home())}`,
    `exec ${[process.execPath, ...runAgentArgv(agentId)].map(shellQuote).join(' ')}`,
    '',
  ].join('\n')
