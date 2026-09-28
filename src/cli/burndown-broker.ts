import type { BrokerClient } from '../client/broker-client.js'
import type { ServerMessage } from '../protocol.js'
import type { TickBroker } from '../agents/burndown/run-tick.js'

/** The tick's broker calls over one unregistered connection, which the broker treats as the human. */

const INBOX_PAGE = 200

type Reply<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

export function tickBroker(client: BrokerClient): TickBroker {
  return {
    async roster() {
      const res = (await client.request(
        { t: 'agents', includeRetired: true },
        'agents_result',
      )) as Reply<'agents_result'>
      return { agents: res.agents, ...(res.slots === undefined ? {} : { slots: res.slots }) }
    },
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
  }
}

const spawnReply = (res: Reply<'spawn_result'>): { ok: boolean; agentId?: string; reason?: string } => ({
  ok: res.ok,
  ...(res.agentId === undefined ? {} : { agentId: res.agentId }),
  ...(res.reason === undefined ? {} : { reason: res.reason }),
})
