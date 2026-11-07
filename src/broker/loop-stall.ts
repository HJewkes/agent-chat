import type { LoopStallHealth } from '../api-contract.js'

/**
 * CC-1699: a broker whose event loop is blocked still accepts socket connections in the kernel,
 * so `service status` showed `socket up` beside `http no answer` and named nothing. A timer that
 * should fire every `intervalMs` measures its own lateness; a late tick is a block, logged as
 * `event_loop_stall` and carried on `/health` so the next outage says what it is.
 */

export const LOOP_TICK_MS = 500
export const LOOP_STALL_MS = 1_000
export const LOOP_STALL_EVENT = 'event_loop_stall'

export interface LoopStallDeps {
  log: (event: string, detail: Record<string, unknown>) => void
  now: () => number
}

export interface LoopStallMonitor {
  /** One tick at `now`; exposed so a test can drive the clock. */
  tick(): void
  health(): LoopStallHealth
}

export function loopStallMonitor(
  deps: LoopStallDeps,
  intervalMs = LOOP_TICK_MS,
  stallMs = LOOP_STALL_MS,
): LoopStallMonitor {
  let last = deps.now()
  const state: LoopStallHealth = { stalls: 0, worst_ms: 0 }
  return {
    tick() {
      const at = deps.now()
      const blockedMs = at - last - intervalMs
      last = at
      if (blockedMs < stallMs) return
      state.stalls++
      state.worst_ms = Math.max(state.worst_ms, blockedMs)
      state.last_ms = blockedMs
      state.last_at = at
      deps.log(LOOP_STALL_EVENT, { blockedMs, stalls: state.stalls })
    },
    health: () => ({ ...state }),
  }
}

/** Ticks on an unref'd interval. Returns the monitor and its cancel. */
export function startLoopStallMonitor(deps: LoopStallDeps): {
  monitor: LoopStallMonitor
  stop: () => void
} {
  const monitor = loopStallMonitor(deps)
  const timer = setInterval(() => monitor.tick(), LOOP_TICK_MS)
  timer.unref?.()
  return { monitor, stop: () => clearInterval(timer) }
}
