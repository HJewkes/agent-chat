import { BrokerClient } from '../client/broker-client.js'
import type { ServerMessage } from '../protocol.js'
import type { TickBroker } from '../agents/burndown/run-tick.js'
import { refusedSender, type OpenSender, type SeatSender } from '../agents/burndown/seat-deliver.js'
import type { BrokerView } from '../agents/burndown/collision.js'
import { LIVE, type Roster } from '../agents/burndown/observe.js'

/** The tick's broker calls over one unregistered connection, which the broker treats as the human; seat events are the exception. */

const INBOX_PAGE = 200

type Reply<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

/** The name seats see on burndown's event messages. */
export const BURNDOWN_SENDER = 'burndown'

export function tickBroker(
  client: BrokerClient,
  seatSender: OpenSender = burndownSender(connectBroker),
): TickBroker {
  return {
    roster: () => tickRoster(client),
    async inboxSince(name, afterId) {
      const frame = { t: 'inbox_since' as const, name, afterId, limit: INBOX_PAGE }
      const res = (await client.request(frame, 'inbox_since_result')) as Reply<'inbox_since_result'>
      return res.messages.map(m => ({
        msgId: m.msgId,
        from: m.from,
        text: m.text,
        ...(m.provenance === undefined ? {} : { provenance: m.provenance }),
        ...(m.inReplyTo === undefined ? {} : { inReplyTo: m.inReplyTo }),
      }))
    },
    async spawn(frame) {
      const res = (await client.request(frame, 'spawn_result')) as Reply<'spawn_result'>
      return spawnReply(res)
    },
    async queue() {
      const res = (await client.request({ t: 'queue' }, 'queue_result')) as Reply<'queue_result'>
      return res.items
    },
    async resume(name, message) {
      const frame = { t: 'resume' as const, name, surface: 'headless' as const, message }
      return spawnReply((await client.request(frame, 'spawn_result')) as Reply<'spawn_result'>)
    },
    async retire(name) {
      const res = (await client.request({ t: 'retire', name }, 'spawn_result')) as Reply<'spawn_result'>
      return spawnReply(res)
    },
    collisionView: () => collisionView(client),
    seatSender,
  }
}

/**
 * Every row, retired ones included, so observe can read a finished agent's report.
 * A slow retired read falls back to the live rows and says so (CC-777): failing the
 * whole tick on it would also cost the collision view.
 */
async function tickRoster(client: BrokerClient): Promise<Roster> {
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

/** Never autostart: a tick that brought up a broker would own it, and the broker serves every session. */
const connectBroker = async (): Promise<BrokerClient> => {
  const client = new BrokerClient(() => undefined, undefined, undefined, undefined, undefined, {
    autoStart: false,
  })
  await client.connect()
  return client
}

/** One connection per tick, registered as `burndown`, so the spawn connection stays unregistered. */
export function burndownSender(connect: () => Promise<BrokerClient>): OpenSender {
  return async () => {
    const client = await connect()
    try {
      const identity = {
        name: BURNDOWN_SENDER,
        workingOn: 'burndown seat events',
        cwd: process.cwd(),
        pid: process.pid,
      }
      const reg = (await client.request(
        { t: 'register', ...identity },
        'register_result',
      )) as Reply<'register_result'>
      if (reg.ok) return registeredSender(client)
      client.close()
      return refusedSender(`register as ${BURNDOWN_SENDER}: ${reg.reason ?? 'refused'}`)
    } catch (err) {
      client.close()
      throw err
    }
  }
}

const registeredSender = (client: BrokerClient): SeatSender => ({
  async send(to, text) {
    const res = (await client.request({ t: 'send', to, text }, 'send_result')) as Reply<'send_result'>
    return { ok: res.ok, ...(res.reason === undefined ? {} : { reason: res.reason }) }
  },
  async notify(text, task) {
    const frame = { t: 'notify' as const, text, ...(task === undefined ? {} : { task }) }
    const res = (await client.request(frame, 'send_result')) as Reply<'send_result'>
    return { ok: res.ok, ...(res.reason === undefined ? {} : { reason: res.reason }) }
  },
  close: () => client.close(),
})

const spawnReply = (res: Reply<'spawn_result'>): { ok: boolean; agentId?: string; reason?: string } => ({
  ok: res.ok,
  ...(res.agentId === undefined ? {} : { agentId: res.agentId }),
  ...(res.reason === undefined ? {} : { reason: res.reason }),
})

/** Live agent and session names and every `files` claim, for `burndown plan`'s collision check (CC-202). */
export async function collisionView(client: BrokerClient): Promise<BrokerView> {
  const roster = (await client.request({ t: 'agents' }, 'agents_result')) as Reply<'agents_result'>
  const list = (await client.request({ t: 'list' }, 'list_result')) as Reply<'list_result'>
  const agents = roster.agents.filter(a => LIVE.has(a.state)).map(a => a.name)
  return {
    names: [...new Set([...agents, ...list.sessions.map(s => s.name)])],
    claims: (list.claims ?? [])
      .filter(c => c.kind === 'files')
      .map(c => ({ owner: c.owner, repo: c.repoPath ?? c.worktreePath, patterns: c.patterns })),
  }
}
