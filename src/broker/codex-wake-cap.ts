import { HUMAN, type ClientMessage, type ServerMessage } from '../protocol.js'
import type { BrokerCore } from './core.js'
import { logEvent } from './log.js'

/**
 * CC-1545: `agent-chat codex run --wake-cap` held a session's records past its hourly cap.
 * Its spawner hears it as one `agent-chat` line, the way it hears an unreported exit, so a
 * session that went quiet on purpose is not mistaken for one that is stuck.
 */

/** The `meta.event` on the notice row. */
export const CODEX_WAKE_CAPPED = 'codex-wake-capped'

type WakeCapped = Extract<ClientMessage, { t: 'codex_wake_capped' }>
type SendResult = Extract<ServerMessage, { t: 'send_result' }>

export const wakeCappedText = (name: string, cap: number): string =>
  `${name} reached its Codex wake cap of ${cap} idle wakes per hour. Messages to it wait in its ` +
  'spool, and the next wake the cap allows carries them all.'

export function noticeWakeCapped<C>(core: BrokerCore<C>, frame: WakeCapped): SendResult {
  const name = core.registry.nameOnHost(frame.hostPid, frame.host)
  if (name === undefined)
    return {
      t: 'send_result',
      ok: false,
      recipients: [],
      reason: `no session registered from pid ${frame.hostPid}`,
    }
  const conn = core.registry.connFor(name)
  const agentId = conn === undefined ? undefined : core.registry.entryFor(conn)?.agentId
  const spawner = (agentId === undefined ? undefined : core.agents.get(agentId)?.spawnedBy) ?? HUMAN
  const body = wakeCappedText(name, frame.cap)
  const { msgId } = core.append({
    kind: spawner === HUMAN ? 'notice' : 'message',
    actor: 'agent-chat',
    target: spawner,
    body,
    meta: { event: CODEX_WAKE_CAPPED, agent: name, cap: String(frame.cap) },
  })
  core.deliverTo(spawner, { msgId, from: 'agent-chat', text: body, at: Date.now(), event: CODEX_WAKE_CAPPED })
  logEvent(CODEX_WAKE_CAPPED, { name, spawner, cap: frame.cap })
  return { t: 'send_result', ok: true, msgId, recipients: [spawner] }
}
