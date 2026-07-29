import type { HealthPayload } from '../api-contract.js'
import { socketPath } from '../paths.js'
import type { BrokerCore } from './core.js'
import { VERSION } from './version.js'

export type { HealthPayload }

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
