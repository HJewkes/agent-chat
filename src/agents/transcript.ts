import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

/** `CLAUDE_CONFIG_DIR` is Claude Code's own override; honouring it keeps us in step. */
const configDir = (): string => process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')

const projectsDir = (): string => path.join(configDir(), 'projects')

/**
 * Derived from 27 real project directories on this machine: every non-alphanumeric
 * byte becomes `-`, including the separators and the dots, so `/Users/h/.claude`
 * lands at `-Users-h--claude`. It is lossy and deliberately not invertible.
 */
export const projectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

export const transcriptPath = (cwd: string, sessionId: string): string =>
  path.join(projectsDir(), projectSlug(cwd), `${sessionId}.jsonl`)

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
export function findTranscript(cwd: string, sessionId: string): Transcript {
  const derived = transcriptPath(cwd, sessionId)
  if (sessionId === '') return { path: derived, exists: false }
  if (fs.existsSync(derived)) return { path: derived, exists: true }

  for (const dir of readProjects()) {
    const candidate = path.join(projectsDir(), dir, `${sessionId}.jsonl`)
    if (fs.existsSync(candidate)) return { path: candidate, exists: true }
  }
  return { path: derived, exists: false }
}

function readProjects(): string[] {
  try {
    return fs
      .readdirSync(projectsDir(), { withFileTypes: true })
      .flatMap(e => (e.isDirectory() ? [e.name] : []))
  } catch {
    // No Claude Code config at all is a legitimate state for a broker running
    // under a service account; it just means there is nothing to point at.
    return []
  }
}

/** One line for a roster: the path, or why there is not one. */
export const transcriptLine = (cwd: string, sessionId: string): string => {
  if (sessionId === '') return 'transcript: none recorded for this agent'
  const found = findTranscript(cwd, sessionId)
  return found.exists ? `transcript: ${found.path}` : `transcript: ${found.path} (not written yet)`
}
