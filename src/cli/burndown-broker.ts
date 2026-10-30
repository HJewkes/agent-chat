import { BrokerClient, retryOnBrokerTimeout } from '../client/broker-client.js'
import type { ServerMessage } from '../protocol.js'
import type { TickBroker } from '../agents/burndown/run-tick.js'
import { refusedSender, type OpenSender, type SeatSender } from '../agents/burndown/seat-deliver.js'
import type { SpawnReply } from '../agents/burndown/execute.js'
import { collisionView, INBOX_PAGE, tickRoster } from './port-reads.js'

export { collisionView }

/** The tick's broker calls over one unregistered connection, which the broker treats as the human; seat events are the exception. */

type Reply<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

/** The name seats see on burndown's event messages. */
export const BURNDOWN_SENDER = 'burndown'

export function tickBroker(
  client: BrokerClient,
  seatSender: OpenSender = burndownSender(connectBroker),
  now: () => number = Date.now,
): TickBroker {
  return {
    roster: () => tickRoster(client),
    async inboxSince(name, afterId) {
      const frame = { t: 'inbox_since' as const, name, afterId, limit: INBOX_PAGE }
      const read = () => client.request(frame, 'inbox_since_result')
      const res = (await retryOnBrokerTimeout(read)) as Reply<'inbox_since_result'>
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
      const frame = {
        t: 'resume' as const,
        name,
        surface: 'headless' as const,
        message,
        source: 'burndown' as const,
      }
      return spawnReply((await client.request(frame, 'spawn_result')) as Reply<'spawn_result'>)
    },
    async retire(name) {
      const res = (await client.request({ t: 'retire', name }, 'spawn_result')) as Reply<'spawn_result'>
      return spawnReply(res)
    },
    async park(name) {
      const res = (await client.request({ t: 'park', name }, 'spawn_result')) as Reply<'spawn_result'>
      return spawnReply(res)
    },
    async retireFinished(spawner) {
      const frame = { t: 'retire_finished' as const, spawner }
      const res = (await client.request(frame, 'retire_finished_result')) as Reply<'retire_finished_result'>
      return {
        ok: res.ok,
        plan: res.plan,
        results: res.results,
        ...(res.reason === undefined ? {} : { reason: res.reason }),
      }
    },
    collisionView: () => collisionView(client, now()),
    seatSender,
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
    try {
      const res = (await client.request({ t: 'send', to, text }, 'send_result')) as Reply<'send_result'>
      return { ok: res.ok, ...(res.reason === undefined ? {} : { reason: res.reason }) }
    } catch (err) {
      // The frame was written; a silent broker may have routed it (CC-640).
      if (err instanceof Error && err.message.startsWith('broker did not answer')) {
        return { ok: false, unknown: true, reason: err.message }
      }
      throw err
    }
  },
  async notify(text, task) {
    const frame = { t: 'notify' as const, text, ...(task === undefined ? {} : { task }) }
    const res = (await client.request(frame, 'send_result')) as Reply<'send_result'>
    return { ok: res.ok, ...(res.reason === undefined ? {} : { reason: res.reason }) }
  },
  close: () => client.close(),
})

const spawnReply = (res: Reply<'spawn_result'>): SpawnReply => ({
  ok: res.ok,
  ...(res.agentId === undefined ? {} : { agentId: res.agentId }),
  ...(res.reason === undefined ? {} : { reason: res.reason }),
  ...(res.code === undefined ? {} : { code: res.code }),
  ...(res.retryable === undefined ? {} : { retryable: res.retryable }),
  ...(res.base === undefined ? {} : { base: res.base }),
})
