/**
 * Re-exports only. The broker splits into state (`core.ts`, the single write
 * path), transport (`socket.ts`, `http.ts`) and the composition that brings them
 * up in the right order (`daemon.ts`); nothing should be defined here.
 *
 * `startBroker` stays exported from THIS module whatever file defines it —
 * `src/cli` imports it from the barrel to run `agent-chat broker`, which is a
 * process-launch contract (`BrokerClient.spawnBroker` spawns that exact argv).
 */
export { startBroker, type StartBrokerOptions } from './daemon.js'
export { BrokerCore, type Conn, type Deliver, type VerdictResult } from './core.js'
export { EventHub, type SseMessage, type Subscriber } from './events.js'
export { buildHttpApp, type HttpAppOptions } from './http.js'
