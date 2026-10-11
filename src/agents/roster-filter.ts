import type { AgentIdentity } from '../protocol.js'

export interface RosterFilter {
  /** Keeps only agents spawned by this name; a successor sharing the name counts. */
  spawner?: string
  prefix?: string
}

export function filterRoster(agents: AgentIdentity[], filter: RosterFilter): AgentIdentity[] {
  return agents.filter(
    a =>
      (filter.spawner === undefined || a.spawnedBy === filter.spawner) &&
      (filter.prefix === undefined || a.name.startsWith(filter.prefix)),
  )
}

/**
 * CC-491: one row per name, the newest non-retired one. A name recurs across
 * adoptions and resumes, and an older row's reading is not that agent today.
 */
export function newestByName(agents: AgentIdentity[]): AgentIdentity[] {
  const newest = new Map<string, AgentIdentity>()
  for (const agent of agents) {
    if (agent.state === 'retired') continue
    const held = newest.get(agent.name)
    if (held === undefined || agent.lastEventAt > held.lastEventAt) newest.set(agent.name, agent)
  }
  return [...newest.values()]
}

/** The name the CLI attributes to the caller: the one a spawned session registers under. */
export function callerName(env: NodeJS.ProcessEnv = process.env): string {
  const name = env.AGENT_CHAT_NAME
  if (!name) {
    throw new Error(
      '--mine needs AGENT_CHAT_NAME, which only spawned agents have, and this shell has none. ' +
        'Use --spawner <your registered name> instead.',
    )
  }
  return name
}
