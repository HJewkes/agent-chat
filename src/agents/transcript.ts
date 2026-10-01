import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { profileDir } from './config-dir.js'
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
 * byte becomes `-`, including the separators and the dots, so `/Users/alice/.claude`
 * lands at `-Users-alice--claude`. It is lossy and deliberately not invertible.
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

/** Session id to transcript path across every profile dir; built on the first miss, then reused. */
export interface ProfileIndex {
  lookup(sessionId: string): string | undefined
}

/**
 * One index per roster listing, never a module global: the broker is long-lived and a cached
 * listing would go stale. Profile dirs are sorted, so a session id present in two of them
 * resolves to the alphabetically first profile.
 */
export function createProfileIndex(): ProfileIndex {
  let byId: Map<string, string> | undefined
  return {
    lookup(sessionId) {
      byId ??= buildProfileIndex()
      return byId.get(sessionId)
    },
  }
}

function buildProfileIndex(): Map<string, string> {
  const byId = new Map<string, string>()
  for (const profile of profileDirs()) {
    for (const project of readProjects(profile)) {
      const folder = path.join(projectsDir(profile), project)
      for (const file of readFiles(folder)) {
        const id = file.endsWith('.jsonl') ? file.slice(0, -'.jsonl'.length) : undefined
        if (id !== undefined && !byId.has(id)) byId.set(id, path.join(folder, file))
      }
    }
  }
  return byId
}

/**
 * CC-261: `findTranscript` for a roster row. An adopted session's row records no config dir,
 * so the default dir would be printed even when it ran under a profile dir. The session id
 * is unique, so searching the profile dirs for it is exact. A recorded dir is never searched past.
 */
export function findAgentTranscript(
  cwd: string,
  sessionId: string,
  dir?: string,
  index: ProfileIndex = createProfileIndex(),
): Transcript {
  const primary = findTranscript(cwd, sessionId, dir)
  if (dir !== undefined || primary.exists || sessionId === '') return primary
  const found = index.lookup(sessionId)
  return found === undefined ? primary : { path: found, exists: true }
}

function profileDirs(): string[] {
  const root = path.dirname(profileDir('x', process.env, os.homedir()))
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .flatMap(e => (e.isDirectory() ? [path.join(root, e.name)] : []))
      .sort()
  } catch {
    return []
  }
}

function readFiles(folder: string): string[] {
  try {
    return fs.readdirSync(folder)
  } catch {
    return []
  }
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

/** One line for a roster: the path, or why there is not one. Passing an index adds the profile-dir search. */
export const transcriptLine = (
  cwd: string,
  sessionId: string,
  dir?: string,
  index?: ProfileIndex,
): string => {
  if (sessionId === '') return 'transcript: none recorded for this agent'
  const found =
    index === undefined
      ? findTranscript(cwd, sessionId, dir)
      : findAgentTranscript(cwd, sessionId, dir, index)
  return found.exists ? `transcript: ${found.path}` : `transcript: ${found.path} (not written yet)`
}
