import { socketPath } from '../paths.js'
import type { BrokerCore } from './core.js'
import { VERSION } from './version.js'

/**
 * Shape served at `GET /health`. Frozen here rather than inline in a route so it
 * is callable — and testable — before any HTTP layer exists, which is the point
 * of building it in this step.
 */
export interface HealthPayload {
  ok: boolean
  version: string
  pid: number
  uptime_ms: number
  port: number | null
  socket: string
  sessions: number
  queue_open: number
}

/**
 * `uptime_ms` is the load-bearing field, not a vanity metric. Process lifetime is
 * the registration lease and the registry is in-memory, so for the few seconds
 * after a restart `sessions` is empty or partial while clients climb the reconnect
 * ladder. A reader that knows uptime is under ~10s can say "broker restarted,
 * sessions reconnecting" instead of rendering an empty table as fact.
 */
export function buildHealthPayload(core: BrokerCore, port: number | null): HealthPayload {
  return {
    ok: true,
    version: VERSION,
    pid: process.pid,
    uptime_ms: Date.now() - core.startedAt,
    port,
    socket: socketPath(),
    sessions: core.registry.list().length,
    queue_open: core.events.humanQueue().length,
  }
}
