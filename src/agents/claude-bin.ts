import fs from 'node:fs'
import path from 'node:path'

/**
 * Resolve an absolute path to the `claude` binary, without depending on `PATH`.
 *
 * ## The bug this exists to close (CC-132)
 *
 * `run-agent.ts` spawns `plan.bin`, which is the bare string `'claude'` —
 * `spawn()` then resolves it against the CHILD's `PATH`, which for a headless
 * agent is the broker's own inherited `PATH`. A broker autostarted by a session
 * with a minimal `PATH` (observed: `/opt/homebrew/.../bin:/usr/bin:/bin`, no
 * `/opt/homebrew/bin`) fails every headless spawn with exit 127, silently: the
 * child never starts and nothing but the exit code says why. Pane spawns never
 * hit this because they run inside an iTerm login shell, which re-sources the
 * user's own `PATH`.
 *
 * ## Resolution order, mirroring `agent-chat-launch.sh`'s `resolve_node`
 *
 * 1. `AGENT_CHAT_CLAUDE` — an explicit override;
 * 2. `claude` on the given `PATH`;
 * 3. `<state dir>/claude-path` — a path written by a previous successful
 *    PATH-based resolution (see `recordClaudeBin` below);
 * 4. the usual install locations for this machine's install methods.
 */

const USUAL_LOCATIONS = ['/opt/homebrew/bin/claude', '$HOME/.local/bin/claude', '/usr/local/bin/claude']

export interface ClaudeBinRequest {
  env: NodeJS.ProcessEnv
  /** Absolute path to the state dir (`~/.agent-chat` unless relocated). */
  stateDir: string
  /** Injected so resolution is testable without a real binary on disk. */
  exists?: (candidate: string) => boolean
  /** Reads the first line of `<state dir>/claude-path`. Injected for the same reason as `exists`. */
  readFirstLine?: (file: string) => string | undefined
  home?: string
}

export type ClaudeBinResolution =
  | { bin: string; source: 'env' | 'path' | 'state-file' | 'well-known' }
  /** Every candidate tried, in order, so the caller can report what was missing. */
  | { error: string; tried: string[] }

const realExists = (candidate: string): boolean => {
  try {
    fs.accessSync(candidate, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

const claudePathFile = (stateDir: string): string => path.join(stateDir, 'claude-path')

const realReadFirstLine = (file: string): string | undefined => {
  try {
    const first = fs.readFileSync(file, 'utf8').split('\n')[0]?.trim()
    return first === '' ? undefined : first
  } catch {
    return undefined
  }
}

const wellKnownLocations = (home: string): string[] =>
  USUAL_LOCATIONS.map(location => location.replace('$HOME', home))

/** Walks every `PATH` dir rather than stopping at the first, matching `checkCliOnPath` in doctor.ts. */
const pathCandidates = (env: NodeJS.ProcessEnv): string[] =>
  (env.PATH ?? '').split(path.delimiter).filter(dir => dir !== '').map(dir => path.join(dir, 'claude'))

export function resolveClaudeBin(req: ClaudeBinRequest): ClaudeBinResolution {
  const exists = req.exists ?? realExists
  const readFirstLine = req.readFirstLine ?? realReadFirstLine
  const home = req.home ?? req.env.HOME ?? ''
  const tried: string[] = []

  if (req.env.AGENT_CHAT_CLAUDE) {
    tried.push(req.env.AGENT_CHAT_CLAUDE)
    if (exists(req.env.AGENT_CHAT_CLAUDE)) return { bin: req.env.AGENT_CHAT_CLAUDE, source: 'env' }
  }

  for (const candidate of pathCandidates(req.env)) {
    tried.push(candidate)
    if (exists(candidate)) return { bin: candidate, source: 'path' }
  }

  const stateFile = claudePathFile(req.stateDir)
  tried.push(stateFile)
  const fromStateFile = readFirstLine(stateFile)
  if (fromStateFile !== undefined && exists(fromStateFile)) return { bin: fromStateFile, source: 'state-file' }

  for (const candidate of wellKnownLocations(home)) {
    tried.push(candidate)
    if (exists(candidate)) return { bin: candidate, source: 'well-known' }
  }

  return { error: `cannot find the claude binary; tried: ${tried.join(', ')}`, tried }
}

/**
 * Best-effort: write the resolved absolute path to `<state dir>/claude-path` so
 * a later broker started with a minimal `PATH` can still find it — the same
 * mechanism `node-path` already provides for node. Never fatal: a write failure
 * here must not fail a spawn that otherwise succeeded.
 */
export function recordClaudeBin(stateDir: string, bin: string, write: (file: string, data: string) => void = fs.writeFileSync): void {
  try {
    write(claudePathFile(stateDir), `${bin}\n`)
  } catch {
    // Best-effort. A failed write here costs nothing but the caching.
  }
}
