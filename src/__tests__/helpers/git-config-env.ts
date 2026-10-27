import path from 'node:path'

const HOOKS_PATH_KEY = 'core.hookspath'
const SHIM_DIR_SEGMENTS = ['.agent-chat', 'git-hooks', 'git-bin']

type Env = Record<string, string | undefined>

/**
 * Drops every `core.hooksPath` pair from an env's GIT_CONFIG_COUNT list, keeps the rest renumbered
 * from 0, and returns the edited env (CC-335). A malformed count leaves the env unchanged.
 */
export function withoutInjectedHooksPath(env: Env): Env {
  const count = Number(env.GIT_CONFIG_COUNT)
  if (env.GIT_CONFIG_COUNT === undefined || !Number.isInteger(count) || count < 0) return env
  const pairs = Array.from({ length: count }, (_, i) => [
    env[`GIT_CONFIG_KEY_${i}`],
    env[`GIT_CONFIG_VALUE_${i}`],
  ])
  const kept = pairs.filter(([key]) => key?.toLowerCase() !== HOOKS_PATH_KEY)
  const out: Env = { ...env }
  for (let i = 0; i < count; i++) {
    delete out[`GIT_CONFIG_KEY_${i}`]
    delete out[`GIT_CONFIG_VALUE_${i}`]
  }
  delete out.GIT_CONFIG_COUNT
  if (kept.length === 0) return out
  out.GIT_CONFIG_COUNT = String(kept.length)
  kept.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${i}`] = key
    out[`GIT_CONFIG_VALUE_${i}`] = value
  })
  return out
}

const isShimPath = (entry: string): boolean => {
  const segments = entry.split(/[\\/]+/).filter(Boolean)
  return segments.some((_, i) => SHIM_DIR_SEGMENTS.every((segment, j) => segments[i + j] === segment))
}

/**
 * Drops the agent git shim from an env (CC-1657): its PATH entries and a GIT_EXEC_PATH that points
 * into its mirror. A spawned session carries both, and the shim refuses the command-line
 * `include.path` fixtures the leak-guard specs run; CI has neither.
 */
export function withoutGitShim(env: Env): Env {
  const out: Env = { ...env }
  if (out.PATH !== undefined) {
    out.PATH = out.PATH.split(path.delimiter)
      .filter(entry => !isShimPath(entry))
      .join(path.delimiter)
  }
  if (out.GIT_EXEC_PATH !== undefined && isShimPath(out.GIT_EXEC_PATH)) delete out.GIT_EXEC_PATH
  return out
}
