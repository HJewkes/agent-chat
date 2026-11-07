/**
 * BS-48: how long to sleep between attempts while a session that may not autostart waits for its
 * broker. A forwarded socket can stay down for hours (a laptop asleep, the ssh forward between
 * restarts), so the wait never gives up; the cap keeps a session that is offline from polling hard.
 */
export const BROKER_WAIT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000]

export interface BrokerWaitDeps {
  /** One connect attempt; true once the broker answered. */
  reach: () => Promise<boolean>
  pause: (ms: number) => Promise<void>
  /** True once the session is ending, so the wait stops with it. */
  stopped?: () => boolean
  delays?: readonly number[]
}

/**
 * Retry `reach` with capped backoff until it succeeds or the session stops. Resolves true when the
 * broker answered, false when stopped first. Never starts a broker: that is the point.
 */
export async function waitForBroker(deps: BrokerWaitDeps): Promise<boolean> {
  const delays = deps.delays ?? BROKER_WAIT_DELAYS_MS
  for (let attempt = 0; ; attempt += 1) {
    if (deps.stopped?.()) return false
    await deps.pause(delays[Math.min(attempt, delays.length - 1)] ?? 0)
    if (deps.stopped?.()) return false
    if (await deps.reach()) return true
  }
}
