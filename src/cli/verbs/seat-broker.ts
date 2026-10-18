import type { RetireFinishedReply } from '../../agents/burndown/daily-retire.js'
import type { WakeResult } from '../../agents/seats/run.js'
import { BrokerClient } from '../../client/broker-client.js'
import type { ServerMessage } from '../../protocol.js'

export const WATCHDOG_SENDER = 'seat-watchdog'

export type Reply<T extends ServerMessage['t']> = Extract<ServerMessage, { t: T }>

export async function sendAsOwner(client: BrokerClient, seat: string, message: string): Promise<WakeResult> {
  const res = (await client.request(
    { t: 'human_send', to: seat, text: message, source: 'watchdog' },
    'send_result',
  )) as Reply<'send_result'>
  return res.ok
    ? { ok: true, detail: `message ${res.msgId}` }
    : { ok: false, detail: res.reason ?? 'send refused' }
}

/** CC-1465: the broker picks the age and the cap; the frame only asks for the stale scope. */
export async function retireStale(client: BrokerClient): Promise<RetireFinishedReply> {
  const frame = { t: 'retire_finished' as const, stale: true }
  const res = (await client.request(frame, 'retire_finished_result')) as Reply<'retire_finished_result'>
  return {
    ok: res.ok,
    plan: res.plan,
    results: res.results,
    ...(res.reason === undefined ? {} : { reason: res.reason }),
  }
}

/** Never autostarts: a seat verb that brought up a broker would own it, and the broker serves every session. */
export async function withRunningBroker<T>(fn: (client: BrokerClient) => Promise<T>): Promise<T> {
  const client = new BrokerClient(() => undefined, undefined, undefined, undefined, undefined, {
    autoStart: false,
  })
  try {
    await client.connect()
    return await fn(client)
  } finally {
    client.close()
  }
}

/** CC-465: the human queue takes a notice only from a registered sender, so a second connection registers for it. */
export async function notifyAsWatchdog(text: string): Promise<WakeResult> {
  return asWatchdog('seat watchdog notices', async client => {
    const res = (await client.request({ t: 'notify', text }, 'send_result')) as Reply<'send_result'>
    return res.ok
      ? { ok: true, detail: `notice ${res.msgId}` }
      : { ok: false, detail: res.reason ?? 'notify refused' }
  })
}

/** CC-1057: a plain peer message from the watchdog sender, so it never arrives as from="human". */
export async function sendAsWatchdog(to: string, text: string): Promise<WakeResult> {
  return asWatchdog('seat block pages', async client => {
    const res = (await client.request({ t: 'send', to, text }, 'send_result')) as Reply<'send_result'>
    return res.ok
      ? { ok: true, detail: `message ${res.msgId}` }
      : { ok: false, detail: res.reason ?? 'send refused' }
  })
}

async function asWatchdog(
  workingOn: string,
  act: (client: BrokerClient) => Promise<WakeResult>,
): Promise<WakeResult> {
  return withRunningBroker(async client => {
    const identity = {
      name: WATCHDOG_SENDER,
      workingOn,
      cwd: process.cwd(),
      pid: process.pid,
    }
    const reg = (await client.request(
      { t: 'register', ...identity },
      'register_result',
    )) as Reply<'register_result'>
    if (!reg.ok) return { ok: false, detail: `register as ${WATCHDOG_SENDER}: ${reg.reason ?? 'refused'}` }
    return act(client)
  })
}
