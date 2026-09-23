import type { BrokerClient } from '../../client/broker-client.js'
import type { ServerMessage } from '../../protocol.js'

/** Shared by chat_ask and chat_notify: both queue a message for the human, differing only in kind. */
export async function toHuman(broker: BrokerClient, kind: 'ask' | 'notify', body: string): Promise<string> {
  const res = (await broker.request({ t: kind, text: body }, 'send_result')) as Extract<
    ServerMessage,
    { t: 'send_result' }
  >
  if (!res.ok) return `Not queued: ${res.reason}`
  return kind === 'ask'
    ? `Question queued for the human (msg_id ${res.msgId}). They may not see it for a while — carry on with other work.`
    : `Notice left for the human (msg_id ${res.msgId}).`
}
