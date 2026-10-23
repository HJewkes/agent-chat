import type { AgentEventRow } from '../../broker/event-store.js'
import type { AgentLifecycle } from '../../protocol.js'
import { foldAgent, groupByAgent } from '../identity.js'
import { recordedRole } from '../profiles.js'
import { BLOCK_PAGE_TO } from './block-page.js'
import { charterSeats, isSeatName } from './charter.js'

/** CC-1348: the seats whose non-MERGE verdict blocks a seat merge: the charter's seats plus the operator. */
export const coordinatorSeats = (charter: string): string[] => {
  const seats = charterSeats(charter).filter(isSeatName)
  return seats.length === 0 ? [] : [...new Set([...seats, BLOCK_PAGE_TO])]
}

/**
 * A teleport appends its successor's spawn row before it retires the predecessor, so one of
 * the two always holds the name. `detached` may still have a process, so it counts too.
 */
const RUNNING: ReadonlySet<AgentLifecycle> = new Set(['spawning', 'live', 'detached'])

/**
 * CC-1559: the coordinators a seat merge waits on, read from the agent event log rather than a list:
 * every name held by a running identity whose spawn row grants the coordinator role. Exited and
 * retired identities drop out, and so does an adopted session still on its directory-derived name.
 */
export function liveCoordinators(rows: readonly AgentEventRow[]): string[] {
  const names = [...groupByAgent(rows).values()].flatMap(group => {
    const agent = foldAgent(group)
    const spawn = group.find(row => row.kind === 'agent_spawned')
    if (agent === undefined || spawn === undefined || !RUNNING.has(agent.state)) return []
    if (agent.provisionalName === true || !isSeatName(agent.name)) return []
    return recordedRole(spawn.meta) === 'coordinator' ? [agent.name] : []
  })
  return [...new Set(names)].sort((a, b) => a.localeCompare(b))
}
