/**
 * TP-4256 A3: the records a launch is checked on, read from one environment. The launcher takes the
 * startup half at spawn from the env the agent will get; the hook takes both halves from its own.
 * Deriving them here once keeps the two reading the same files.
 */
import os from 'node:os'
import path from 'node:path'
import { nodeFs, sessionSet, startupSet, type RecordFs, type Records } from './record.js'

type Env = Readonly<Record<string, string | undefined>>

const homeOf = (env: Env): string => env.HOME || os.homedir()

/** The startup files a shell with `env` sources: HOME's and ZDOTDIR's, BASH_ENV and ENV. */
export const startupRecords = (env: Env, io: RecordFs = nodeFs): Records =>
  startupSet(homeOf(env), env.ZDOTDIR, env, io)

/** What the hook reports: the startup files, and the session's snapshots, session-env and CLAUDE_ENV_FILE. */
export function currentRecords(sessionId: string, env: Env, io: RecordFs = nodeFs): Records {
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(homeOf(env), '.claude')
  return { ...startupRecords(env, io), ...sessionSet(configDir, sessionId, env, io) }
}
