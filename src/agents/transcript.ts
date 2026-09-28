import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  claudeSourceFromPath,
  readRecentSessionTurnsSync,
  type RecentObservedValue,
} from '@titan-design/session-read'

/**
 * Where Claude Code's own per-session transcript lives, for an agent we spawned.
 *
 * This is what makes discarding a headless agent's stdout safe. We pass
 * `--session-id` at launch (`launch-plan.ts`) and record it on `agent_spawned`,
 * so the transcript is already ours to find — a complete, structured, live record
 * written by Claude Code whether we read the pipe or not. Duplicating it into a
 * `stream.jsonl` of our own would be a second copy of a file that already exists.
 *
 * Nothing here is authoritative about lifecycle. It is a pointer to telemetry
 * owned by another program, which may be absent (`--no-session-persistence`) or
 * reaped (`cleanupPeriodDays`, 30 by default). Treat a miss as normal.
 */

/**
 * Whose dir to look in.
 *
 * The env-based default answers for THIS process — the broker's own session, and
 * the human at the CLI. It is the wrong answer for an agent, which may have been
 * launched on a different account entirely (CC-100): every function below takes
 * the dir as an optional argument so an agent lookup can pass the one recorded on
 * the agent's own spawn row. Passing nothing keeps the previous behaviour.
 */
export const configDir = (): string => process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')

const projectsDir = (dir: string = configDir()): string => path.join(dir, 'projects')

/**
 * Derived from 27 real project directories on this machine: every non-alphanumeric
 * byte becomes `-`, including the separators and the dots, so `/Users/h/.claude`
 * lands at `-Users-h--claude`. It is lossy and deliberately not invertible.
 */
export const projectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

export const transcriptPath = (cwd: string, sessionId: string, dir?: string): string =>
  path.join(projectsDir(dir), projectSlug(cwd), `${sessionId}.jsonl`)

export interface Transcript {
  path: string
  /** False for an agent that has not written its first turn yet — a normal state, not an error. */
  exists: boolean
}

/**
 * The derived path, corrected against reality when it is wrong.
 *
 * The slug is computed from the cwd we asked for, but Claude Code records the cwd
 * it resolved — and those differ through a symlink. One of the 27 directories
 * sampled was exactly that case, so the derivation is a fast path rather than a
 * guarantee. The session id is a uuid and therefore unique across every project,
 * which makes scanning for it an exact answer rather than a heuristic one.
 */
export function findTranscript(cwd: string, sessionId: string, dir?: string): Transcript {
  const derived = transcriptPath(cwd, sessionId, dir)
  if (sessionId === '') return { path: derived, exists: false }
  if (fs.existsSync(derived)) return { path: derived, exists: true }

  for (const project of readProjects(dir)) {
    const candidate = path.join(projectsDir(dir), project, `${sessionId}.jsonl`)
    if (fs.existsSync(candidate)) return { path: candidate, exists: true }
  }
  return { path: derived, exists: false }
}

function readProjects(dir?: string): string[] {
  try {
    return fs
      .readdirSync(projectsDir(dir), { withFileTypes: true })
      .flatMap(e => (e.isDirectory() ? [e.name] : []))
  } catch {
    // No Claude Code config at all is a legitimate state for a broker running
    // under a service account; it just means there is nothing to point at.
    return []
  }
}

/**
 * The model the newest real assistant turn ran on, from `message.model` on
 * Claude Code's own transcript; teleport copies it for a human-started session.
 * Telemetry owned by another program, so undefined means "could not tell" and
 * the caller inherits the harness default. session-read skips `<synthetic>`.
 */
export function observedModel(cwd: string, sessionId: string, dir?: string): string | undefined {
  const found = findTranscript(cwd, sessionId, dir)
  if (!found.exists) return undefined
  const model = readModel(found.path)
  return model?.status === 'observed' ? model.value : undefined
}

/** Only the tail is read: a long session's transcript runs to megabytes. */
const MODEL_TAIL_BYTES = 256 * 1024

/** session-read throws `TypeError` on a window that names another session; that is a miss here. */
const FOREIGN_SESSION =
  /^Claude (transcript record belongs to native session|sidechain window names multiple)/

function readModel(file: string): RecentObservedValue<string> | undefined {
  try {
    const source = claudeSourceFromPath(file, 'local')
    return readRecentSessionTurnsSync(source, { maxBytes: MODEL_TAIL_BYTES, maxTurns: 1, maxCharsPerTurn: 1 })
      .model
  } catch (error) {
    if (error instanceof TypeError && FOREIGN_SESSION.test(error.message)) return undefined
    throw error
  }
}

/** One line for a roster: the path, or why there is not one. */
export const transcriptLine = (cwd: string, sessionId: string, dir?: string): string => {
  if (sessionId === '') return 'transcript: none recorded for this agent'
  const found = findTranscript(cwd, sessionId, dir)
  return found.exists ? `transcript: ${found.path}` : `transcript: ${found.path} (not written yet)`
}
