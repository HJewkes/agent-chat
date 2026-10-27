import fs from 'node:fs'
import path from 'node:path'
import { gitMirrorDirFor } from '../leak-guard/git-mirror.js'
import { GIT_SHIM_DIR_ENV } from '../leak-guard/git-shim.js'
import { hooksDirOf } from '../leak-guard/hooks-dir.js'
import { holdsAgentChatShim } from '../leak-guard/shim-header.js'

/**
 * A full `PATH` for the broker and its agents, whoever autostarted the broker (CC-456).
 *
 * A broker autostarted by a session's MCP server inherits that server's minimal `PATH`
 * (observed: git-bin, the gh shim, node's Cellar dir, `/usr/bin:/bin`). Headless agents
 * inherit it in turn, so they lose `/opt/homebrew/bin` (agent-chat, gh, pnpm) and
 * `/usr/sbin`; an agent without `agent-chat gh-write` reached for an absolute gh instead.
 * `claude-bin.ts` closed the same gap for the claude binary alone (CC-132).
 *
 * The inherited entries stay first, less any dir holding an agent-chat shim (CC-1653): a launch
 * puts its own shims back first, and an inherited one would be baked as a later shim's real git.
 * After them come, in order:
 * 1. `AGENT_CHAT_BASE_PATH`, an explicit override;
 * 2. `<state dir>/login-path`, the `PATH` of the last `agent-chat service start` from a shell;
 * 3. the usual bin dirs that exist on this machine.
 */

export const BASE_PATH_ENV = 'AGENT_CHAT_BASE_PATH'

const KNOWN_DIRS = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '$HOME/.local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
]

export interface BasePathRequest {
  env: NodeJS.ProcessEnv
  /** Absolute path to the state dir (`~/.agent-chat` unless relocated). */
  stateDir: string
  /** Injected so resolution is testable without the dirs on disk. */
  isDir?: (dir: string) => boolean
  /** Reads the first line of `<state dir>/login-path`. Injected for the same reason as `isDir`. */
  readFirstLine?: (file: string) => string | undefined
  /** True for a dir holding an agent-chat shim. Injected for the same reason as `isDir`. */
  isShimDir?: (dir: string) => boolean
}

const realIsDir = (dir: string): boolean => {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

const realReadFirstLine = (file: string): string | undefined => {
  try {
    const first = fs.readFileSync(file, 'utf8').split('\n')[0]?.trim()
    return first === '' ? undefined : first
  } catch {
    return undefined
  }
}

const loginPathFile = (stateDir: string): string => path.join(stateDir, 'login-path')

const entries = (value: string | undefined): string[] =>
  (value ?? '').split(path.delimiter).filter(entry => entry !== '')

export function resolveBasePath(req: BasePathRequest): string {
  const isDir = req.isDir ?? realIsDir
  const readFirstLine = req.readFirstLine ?? realReadFirstLine
  const isShimDir = req.isShimDir ?? holdsAgentChatShim
  const home = req.env.HOME
  const known = KNOWN_DIRS.filter(dir => home !== undefined || !dir.includes('$HOME'))
    .map(dir => dir.replace('$HOME', home ?? ''))
    .filter(isDir)
  const all = [
    ...entries(req.env.PATH),
    ...entries(req.env[BASE_PATH_ENV]),
    ...entries(readFirstLine(loginPathFile(req.stateDir))),
    ...known,
  ]
  return [...new Set(all)].filter(dir => !isShimDir(dir)).join(path.delimiter)
}

/**
 * CC-1653: what a broker started from an agent session inherits of that agent's push guard. The
 * shim dir, a GIT_EXEC_PATH at a shim's mirror and the hooks-path pair belong to that one launch;
 * each later launch sets its own.
 */
export function clearInheritedShimEnv(env: NodeJS.ProcessEnv): void {
  const shimDir = env[GIT_SHIM_DIR_ENV]
  delete env[GIT_SHIM_DIR_ENV]
  const execPath = env.GIT_EXEC_PATH
  if (execPath !== undefined && (holdsAgentChatShim(execPath) || execPath === mirrorOf(shimDir)))
    delete env.GIT_EXEC_PATH
  if (hooksDirOf(env as Record<string, string>) === undefined) return
  for (const key of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) delete env[key]
}

const mirrorOf = (shimDir: string | undefined): string | undefined =>
  shimDir === undefined ? undefined : gitMirrorDirFor(shimDir)

/** Best-effort, like `recordClaudeBin`: a failed write costs a later broker the recorded dirs, not a start. */
export function recordLoginPath(
  stateDir: string,
  PATH: string | undefined,
  write: (file: string, data: string) => void = fs.writeFileSync,
): void {
  if (PATH === undefined || PATH === '') return
  try {
    write(loginPathFile(stateDir), `${PATH}\n`)
  } catch {
    // Best-effort. The known dirs still apply without it.
  }
}
