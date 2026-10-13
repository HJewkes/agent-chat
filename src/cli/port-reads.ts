import type { BrokerClient } from '../client/broker-client.js'
import type { ServerMessage } from '../protocol.js'
import type { BrokerView } from '../agents/burndown/collision.js'
import { LIVE, type Roster } from '../agents/burndown/observe.js'
import { TICK_INTERVAL_SECONDS } from '../agents/burndown/tick-status.js'

/** The tick's read ports, shared by its in-process broker and the `port` verbs (CC-1194). */

/** The most messages one `inbox_since` read returns. */
export const INBOX_PAGE = 200

type Reply<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

/**
 * Every row, retired ones included, so observe can read a finished agent's report.
 * A slow retired read falls back to the live rows and says so (CC-777): failing the
 * whole tick on it would also cost the collision view.
 */
export async function tickRoster(client: BrokerClient): Promise<Roster> {
  const read = async (includeRetired: boolean): Promise<Roster> => {
    const frame = includeRetired ? { t: 'agents' as const, includeRetired } : { t: 'agents' as const }
    const res = (await client.request(frame, 'agents_result')) as Reply<'agents_result'>
    return { agents: res.agents, ...(res.slots === undefined ? {} : { slots: res.slots }) }
  }
  try {
    return await read(true)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { ...(await read(false)), partial: `retired rows unread (${reason})` }
  }
}

/** Live agent and session names and every `files` claim, for `burndown plan`'s collision check (CC-202). */
export async function collisionView(client: BrokerClient, now: number = Date.now()): Promise<BrokerView> {
  const roster = (await client.request({ t: 'agents' }, 'agents_result')) as Reply<'agents_result'>
  const list = (await client.request({ t: 'list' }, 'list_result')) as Reply<'list_result'>
  const agents = roster.agents.filter(a => LIVE.has(a.state)).map(a => a.name)
  const since = now - TICK_INTERVAL_SECONDS * 1000
  const recentlyExited = roster.agents
    .filter(a => a.state === 'exited' && a.exitedAt !== undefined && a.exitedAt > since)
    .map(a => a.name)
  return {
    names: [...new Set([...agents, ...list.sessions.map(s => s.name)])],
    recentlyExited,
    claims: (list.claims ?? [])
      .filter(c => c.kind === 'files')
      .map(c => ({ owner: c.owner, repo: c.repoPath ?? c.worktreePath, patterns: c.patterns })),
  }
}
