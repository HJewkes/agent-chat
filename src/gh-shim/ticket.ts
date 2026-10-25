import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * CC-1644: `agent-chat gh-write` proves to the gh shim that it scanned a command by an HMAC over
 * the exact argv it hands gh, keyed by the launch's own key. A text write's argv names gh-write's
 * fresh 0600 copy paths, so a ticket cannot be reused for other text or another command.
 */
export const GH_WRITE_TICKET_ENV = 'AGENT_CHAT_GH_WRITE_TICKET'

/** A ticket lives long enough for one gh start; each throttle retry mints its own. */
export const TICKET_TTL_MS = 60_000

const TICKET_LABEL = 'agent-chat gh-write ticket v1'
const VERSION = 'v1'
const NONCE_SHAPE = /^[0-9a-f]{32}$/
const HMAC_SHAPE = /^[0-9a-f]{64}$/
const EXPIRY_SHAPE = /^[0-9]{1,15}$/

const ticketMac = (key: string, agentId: string, expiry: string, nonce: string, argv: string[]): string =>
  createHmac('sha256', key)
    .update(`${TICKET_LABEL}\n${agentId}\n${expiry}\n${nonce}\n${JSON.stringify(argv)}`)
    .digest('hex')

export function mintTicket(
  key: string,
  agentId: string,
  argv: string[],
  now: number,
  nonce: string = randomBytes(16).toString('hex'),
): string {
  const expiry = String(now + TICKET_TTL_MS)
  return [VERSION, expiry, nonce, ticketMac(key, agentId, expiry, nonce, argv)].join('.')
}

/** False for any malformed, expired, too-far-future or mismatched ticket; never throws on hostile input. */
export function verifyTicket(
  key: string,
  agentId: string,
  argv: string[],
  ticket: unknown,
  now: number,
): boolean {
  if (typeof ticket !== 'string') return false
  const parts = ticket.split('.')
  if (parts.length !== 4) return false
  const [version, expiry, nonce, mac] = parts as [string, string, string, string]
  if (version !== VERSION || !EXPIRY_SHAPE.test(expiry)) return false
  if (!NONCE_SHAPE.test(nonce) || !HMAC_SHAPE.test(mac)) return false
  const expiresAt = Number(expiry)
  if (expiresAt <= now || expiresAt > now + TICKET_TTL_MS) return false
  return timingSafeEqual(Buffer.from(mac), Buffer.from(ticketMac(key, agentId, expiry, nonce, argv)))
}
