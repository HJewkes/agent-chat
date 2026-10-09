import { HUMAN, RESERVED_NAMES, type ClientMessage } from '../protocol.js'
import { shapeMeta } from '../inbox/item-shape.js'
import type { BrokerCore } from './core.js'
import { logEvent } from './log.js'

/**
 * Open questions one service label may hold. Higher than a session's budget
 * because a service such as the factory gate notifier has one question per open
 * gate, and several gates can be open at once.
 */
export const MAX_OPEN_SERVICE_QUESTIONS = 20

const MAX_TEXT = 4000
const LABEL = /^[a-z0-9][a-z0-9._-]{0,47}$/

/** The `meta.source` every service question carries; the decider path refuses it. */
export const SERVICE_SOURCE = 'service'

type ServiceAsk = Extract<ClientMessage, { t: 'service_ask' }>
export type ServiceAskOutcome = { ok: true; msgId: string } | { ok: false; reason: string }

/**
 * Why `as` may not label a service question, or undefined when it may.
 *
 * A label that is a live session or a durable agent would put the question in
 * that agent's name, and answers to it would be pushed to whoever holds the name.
 */
function labelRefusal(core: BrokerCore, as: unknown): string | undefined {
  if (typeof as !== 'string' || !LABEL.test(as))
    return 'as must be a lowercase label of 1-48 characters: letters, digits, ".", "_" or "-"'
  if (RESERVED_NAMES.has(as)) return `"${as}" is a reserved name`
  if (core.registry.connFor(as) !== undefined) return `"${as}" is a connected session's name`
  if (core.agents.roster().some(agent => agent.name === as)) return `"${as}" names an agent in the roster`
  if (core.events.openCount(as, 'question') >= MAX_OPEN_SERVICE_QUESTIONS)
    return `"${as}" already has ${MAX_OPEN_SERVICE_QUESTIONS} open questions; resolve or dismiss one first`
  return undefined
}

function textRefusal(text: unknown): string | undefined {
  if (typeof text !== 'string' || text.trim() === '') return 'text is empty'
  if (text.length > MAX_TEXT) return `text is longer than ${MAX_TEXT} characters`
  return undefined
}

/**
 * File a service question for the human. The caller has already established the
 * connection is unregistered; this checks the frame and writes the row.
 */
export function fileServiceAsk(core: BrokerCore, msg: ServiceAsk): ServiceAskOutcome {
  const reason = labelRefusal(core, msg.as) ?? textRefusal(msg.text)
  if (reason) return { ok: false, reason }
  const { msgId } = core.append({
    kind: 'question',
    actor: msg.as,
    target: HUMAN,
    body: msg.text,
    meta: { ...shapeMeta(msg), source: SERVICE_SOURCE },
  })
  logEvent('route', {
    kind: 'question',
    msgId,
    from: msg.as,
    to: HUMAN,
    delivered: true,
    recipients: [HUMAN],
    source: SERVICE_SOURCE,
  })
  return { ok: true, msgId }
}
