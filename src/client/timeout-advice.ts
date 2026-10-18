import type { KeyedFrame } from '../protocol-fingerprint.js'

/**
 * CC-1454: what a caller should check after a keyed `send` or `resume` timed out.
 * The broker may still act on it, so "not answered" must not read as "not done".
 * `sender` is the registered name, which is what events.db records as the actor.
 */
export function timeoutAdvice(frame: KeyedFrame, nonce: string, sentAt: number, sender?: string): string {
  const retry =
    `A retry of this exact ${frame.t} from this process within 10 minutes reuses idempotency key ` +
    `${nonce}, so the broker acts on it at most once.`
  if (frame.t === 'resume')
    return (
      `the broker may still resume ${frame.name}. Before retrying, check agent_list prefix:${frame.name} ` +
      `for a live row, or events.db for kind='agent_resumed' AND target='${frame.name}' AND ts >= ${sentAt}. ` +
      retry
    )
  const actor = sender === undefined ? '' : ` AND actor='${sender}'`
  const activity = typeof frame.to === 'string' ? `chat_activity name:${frame.to} for your message, or ` : ''
  return (
    `the broker may still deliver this message. Before retrying, check ${activity}events.db for ` +
    `kind='message'${actor} AND ts >= ${sentAt}. ${retry}`
  )
}
