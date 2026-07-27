import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The one command every surface launches: `agent-chat run-agent <id>`.
 *
 * A surface never sees `plan.bin` or `plan.args`. The plan is already on disk and
 * `run-agent` is what reads it, which is what keeps a model-authored brief out of
 * every command line — AppleScript only ever carries a fixed string with an
 * 8-char id in it. See launch-files.ts for the longer version of this argument.
 */

/** dist/cli.js — the same resolution broker-client uses to restart the broker. */
const cliEntry = (): string => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'cli.js')

export const runAgentArgv = (agentId: string): string[] => [cliEntry(), 'run-agent', agentId]

/** Single-quoted for /bin/sh: paths here are ours, but they can still hold spaces. */
const shellQuote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`

/** For surfaces that hand a shell a line to type, rather than spawning argv directly. */
export const runAgentCommand = (agentId: string): string =>
  [process.execPath, ...runAgentArgv(agentId)].map(shellQuote).join(' ')
