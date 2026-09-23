import type { HealthPayload } from '../api-contract.js'
import type { SlotUsage } from '../agents/semaphore.js'
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
 *
 * `slots` (CC-139) comes from the caller because the supervisor lives on
 * `SocketServer`, not on `BrokerCore` — this stays a pure read of what it is given
 * rather than reaching across that boundary itself, and omits the field when a
 * caller (a unit test, say) has none to offer.
 */
export function buildHealthPayload(core: BrokerCore, port: number | null, slots?: SlotUsage): HealthPayload {
  return {
    ok: true,
    version: VERSION,
    pid: process.pid,
    uptime_ms: Date.now() - core.startedAt,
    port,
    socket: socketPath(),
    sessions: core.registry.list().length,
    queue_open: core.events.humanQueue().length,
    ...(slots === undefined ? {} : { slots }),
  }
}
