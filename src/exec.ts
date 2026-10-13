import { spawnSync } from 'node:child_process'
import { pinGitProtocols } from './git.js'

/**
 * agent-chat's sync subprocess runner (`git`, `gh`, `titan-factory`). Argv only, a
 * timeout, and an environment without the agent-chat identity: a child that
 * inherits `AGENT_CHAT_NAME`/`AGENT_CHAT_AGENT_ID` registers as its parent and
 * displaces it (CC-174), and a caller run from an agent's shell carries both.
 * GIT_ALLOW_PROTOCOL is pinned so its git never runs an `ext::` remote (CC-1095).
 */

export const IDENTITY_ENV = ['AGENT_CHAT_NAME', 'AGENT_CHAT_AGENT_ID'] as const

export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, GIT_ALLOW_PROTOCOL: pinGitProtocols(env.GIT_ALLOW_PROTOCOL) }
  for (const key of IDENTITY_ENV) delete out[key]
  return out
}

export interface RunResult {
  status: number | null
  stdout: string
  /** Read only to classify a failure (an HTTP status); never relayed, since it can quote content. */
  stderr?: string
  /** Set when the child was killed for outliving its timeout, so a caller can tell "slow" from "broken" (CC-1125). */
  timedOut?: boolean
}

export interface RunOptions {
  /** Overrides the default 15 s for one call whose child is known to run longer. */
  timeoutMs?: number
}

export type Runner = (bin: string, args: string[], cwd?: string, options?: RunOptions) => RunResult

const TIMEOUT_MS = 15_000
/** `shepherd status --json --all` lists finished runs too and passed Node's 1 MiB default (CC-1149); same bound as egress-runner. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

/** A spawn failure (missing binary, timeout) is a non-zero result, never a throw: callers treat it as "could not tell". */
export const run: Runner = (bin, args, cwd, options) => {
  const result = spawnSync(bin, args, {
    cwd,
    env: childEnv(),
    encoding: 'utf8',
    timeout: options?.timeoutMs ?? TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    status: result.error === undefined ? result.status : null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
  }
}

export interface ExecFailureContext {
  cwd: string
  elapsedMs: number
}

const STDERR_CHARS = 200

/**
 * One line naming why an async `execFile` failed (CC-1096): exit code, or the signal and whether
 * the timeout sent it, then elapsed time, cwd and the first stderr line. Its message alone reads
 * "Command failed: <argv>", which cannot tell a timeout from a crash from a missing binary.
 */
export function describeExecFailure(err: unknown, { cwd, elapsedMs }: ExecFailureContext): string {
  const e = (err ?? {}) as ExecError
  const stderr = firstNonEmptyLine(typeof e.stderr === 'string' ? e.stderr : '')
  return `${failureKind(e, err, Math.round(elapsedMs))}, cwd ${cwd}${stderr === '' ? '' : `: ${stderr}`}`
}

interface ExecError {
  code?: unknown
  signal?: unknown
  killed?: unknown
  stderr?: unknown
  message?: unknown
}

/** execFile reports a timeout as `killed` plus `signal`, with `code` null; ETIMEDOUT is spawnSync's. */
function failureKind(e: ExecError, err: unknown, ms: number): string {
  if (typeof e.code === 'number') return `exit ${e.code} after ${ms} ms`
  if (typeof e.code === 'string') return `${e.code} after ${ms} ms`
  if (typeof e.signal === 'string')
    return `killed by ${e.signal} after ${ms} ms${e.killed === true ? ' (timeout)' : ''}`
  return `${firstNonEmptyLine(String(e.message ?? err))} after ${ms} ms`
}

const firstNonEmptyLine = (s: string): string =>
  (s.split('\n').find(line => line.trim() !== '') ?? '').trim().slice(0, STDERR_CHARS)
