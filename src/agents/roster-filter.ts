import type { AgentIdentity, RosterHidden, RosterView } from '../protocol.js'

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

const CACHE_DIR = /(^|\/)(Library\/Caches|\.cache)(\/|$)/

/** The OS's cache directories, where a scheduled job runs and nobody works. */
export const isCacheDir = (cwd: string): boolean => CACHE_DIR.test(cwd)

/**
 * CC-1678: an adopted row minted for a headless job in a cache dir, which never chose a name. New
 * sessions there no longer register (`provisionalName`), but the log keeps the rows already minted.
 */
export const isTransientSession = (agent: AgentIdentity): boolean =>
  agent.origin === 'adopted' && agent.provisionalName === true && isCacheDir(agent.cwd)

/**
 * CC-1464: the agent_list page. Broker and client both run it, so a new client
 * against an old broker, which ignores `view` and sends everything, shows the
 * same rows. Run on its own output it changes nothing.
 */
export function viewRoster(
  agents: AgentIdentity[],
  view: RosterView,
): { agents: AgentIdentity[]; hidden: RosterHidden } {
  const hidden: RosterHidden = { finished: 0, retired: 0, overLimit: 0 }
  const kept = filterRoster(agents, view).filter(a => {
    if (a.state === 'retired' && view.includeRetired !== true) hidden.retired++
    else if ((a.state === 'exited' || isTransientSession(a)) && view.includeFinished !== true)
      hidden.finished++
    else return true
    return false
  })
  const limit = view.limit ?? kept.length
  hidden.overLimit = Math.max(0, kept.length - limit)
  return { agents: kept.slice(0, limit), hidden }
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
