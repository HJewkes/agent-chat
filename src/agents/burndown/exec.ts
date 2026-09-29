import { spawnSync } from 'node:child_process'

/**
 * The tick's only way to run a subprocess (`git`, `gh`). Argv only, a
 * timeout, and an environment without the agent-chat identity: a child that
 * inherits `AGENT_CHAT_NAME`/`AGENT_CHAT_AGENT_ID` registers as its parent and
 * displaces it (CC-174), and a tick run from an agent's shell carries both.
 */

export const IDENTITY_ENV = ['AGENT_CHAT_NAME', 'AGENT_CHAT_AGENT_ID'] as const

export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env }
  for (const key of IDENTITY_ENV) delete out[key]
  return out
}

export interface RunResult {
  status: number | null
  stdout: string
  /** Read only to classify a failure (an HTTP status); never relayed, since it can quote content. */
  stderr?: string
}

export type Runner = (bin: string, args: string[], cwd?: string) => RunResult

const TIMEOUT_MS = 15_000

/** A spawn failure (missing binary, timeout) is a non-zero result, never a throw: callers treat it as "could not tell". */
export const run: Runner = (bin, args, cwd) => {
  const result = spawnSync(bin, args, {
    cwd,
    env: childEnv(),
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    status: result.error === undefined ? result.status : null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}
