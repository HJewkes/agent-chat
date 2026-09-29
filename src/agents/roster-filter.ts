import type { AgentIdentity } from '../protocol.js'

export interface RosterFilter {
  /** The caller's registered name; keeps only agents it spawned. */
  mine?: string
  prefix?: string
}

export function filterRoster(agents: AgentIdentity[], filter: RosterFilter): AgentIdentity[] {
  return agents.filter(
    a =>
      (filter.mine === undefined || a.spawnedBy === filter.mine) &&
      (filter.prefix === undefined || a.name.startsWith(filter.prefix)),
  )
}

/** The name the CLI attributes to the caller: the one a spawned session registers under. */
export function callerName(env: NodeJS.ProcessEnv = process.env): string {
  const name = env.AGENT_CHAT_NAME
  if (!name) {
    throw new Error(
      '--mine needs a registered session name (AGENT_CHAT_NAME), and this shell has none. ' +
        'Use --prefix <p> instead, or run it from an agent session.',
    )
  }
  return name
}
