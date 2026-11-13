import { observedPresence, withPinnedGitProtocols, type GitRunner } from '@titan-design/worktree'
import type { ObservedPresence } from './protocol.js'

export {
  SAFE_GIT_PROTOCOLS,
  pinGitProtocols,
  withPinnedGitProtocols,
  gitChildEnv,
  runGit,
  findGitRoot,
  observedPresence,
  type GitRunner,
} from '@titan-design/worktree'

/**
 * `withPinnedGitProtocols` for an env of strings only: a list git would rank over the caller's own
 * `protocol.*.allow` is left unset, and `protocol.ext.allow=never` goes last in GIT_CONFIG_COUNT (CC-1607).
 */
export function pinnedGitEnv(env: Record<string, string>): Record<string, string> {
  const pinned: Record<string, string> = {}
  for (const [name, value] of Object.entries(withPinnedGitProtocols(env))) {
    if (value !== undefined) pinned[name] = value
  }
  return pinned
}

/**
 * The `observed` half of a registration, spread-ready, so both register paths
 * (the model calling chat_register and a spawned agent registering from its
 * environment) derive it the same way rather than each rolling their own.
 *
 * Not all of it is git. `configDir` joins the git facts because it belongs to the
 * same trust class and travels on the same frame: read from this process's own
 * environment, never typed by a model, and unknowable to a broker that runs
 * detached in a directory of its own (CC-100).
 *
 * Never throws: git is absent on some machines and a registration that failed
 * because a subprocess did not exist would be a far worse bug than an
 * unannotated session.
 */
export async function observedRegistration(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
  git?: GitRunner,
): Promise<{ observed?: ObservedPresence }> {
  const inGit = await observedPresence(cwd, git)
  const observed: ObservedPresence = {
    ...inGit,
    ...(env.CLAUDE_CONFIG_DIR ? { configDir: env.CLAUDE_CONFIG_DIR } : {}),
  }
  return Object.keys(observed).length === 0 ? {} : { observed }
}
