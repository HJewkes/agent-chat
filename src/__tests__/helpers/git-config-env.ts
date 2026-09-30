const HOOKS_PATH_KEY = 'core.hookspath'

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
