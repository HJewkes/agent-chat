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

/** Only the tail is read: a long session's transcript runs to megabytes. */
const TAIL_BYTES = 256 * 1024

/**
 * The model the newest assistant turn actually ran on.
 *
 * Teleport's rule is that a descendant replicates the configuration its
 * predecessor is running under, and for an ordinary human-started session there
 * is no profile to copy it from — the model is not in the environment either
 * (`CLAUDE_CODE_SESSION_ID` and the rest are, this is not). It IS on every
 * assistant row of Claude Code's own transcript, as `message.model`. Observed on
 * a live transcript, not inferred: `claude-opus-5` on 39 of 39 assistant rows of
 * the session that wrote this.
 *
 * Telemetry owned by another program, so every failure is a miss rather than a
 * throw — undefined means "could not tell", and the caller inherits the
 * harness default instead of guessing a model on the human's behalf.
 */
export function observedModel(cwd: string, sessionId: string): string | undefined {
  const found = findTranscript(cwd, sessionId)
  if (!found.exists) return undefined
  try {
    const handle = fs.openSync(found.path, 'r')
    try {
      const size = fs.fstatSync(handle).size
      const length = Math.min(size, TAIL_BYTES)
      const buffer = Buffer.alloc(length)
      fs.readSync(handle, buffer, 0, length, size - length)
      return newestModel(buffer.toString('utf8'))
    } finally {
      fs.closeSync(handle)
    }
  } catch {
    return undefined
  }
}

function newestModel(tail: string): string | undefined {
  const lines = tail.split('\n')
  // Newest first, and the first line is skipped: reading from an offset almost
  // always lands mid-row, and half a JSON object is not a parse failure worth
  // reporting — it is the price of not reading the whole file.
  for (let at = lines.length - 1; at > 0; at--) {
    try {
      const row = JSON.parse(lines[at] ?? '') as { message?: { model?: unknown } }
      const model = row.message?.model
      if (typeof model === 'string' && model !== '') return model
    } catch {
      continue
    }
  }
  return undefined
}

/** One line for a roster: the path, or why there is not one. */
export const transcriptLine = (cwd: string, sessionId: string): string => {
  if (sessionId === '') return 'transcript: none recorded for this agent'
  const found = findTranscript(cwd, sessionId)
  return found.exists ? `transcript: ${found.path}` : `transcript: ${found.path} (not written yet)`
}
