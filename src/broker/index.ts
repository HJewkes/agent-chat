/**
 * Re-exports only. The broker splits into state (`core.ts`, the single write
 * path) and transport (`socket.ts`); nothing should be defined here, so that
 * the HTTP layer added later has an obvious seam to attach to rather than a
 * reason to reach into the socket server.
 */
export { startBroker } from './socket.js'
export { BrokerCore, type Conn, type Deliver, type VerdictResult } from './core.js'
export { EventHub, type SseMessage, type Subscriber } from './events.js'
