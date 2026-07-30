/**
 * §11.3: "a spawn budget per requester per window, mirroring the broadcast
 * budget already in registry.ts:63-64 and the MAX_OPEN_QUESTIONS = 3 budget at
 * broker/index.ts:18." This is that budget.
 *
 * The semaphore bounds the STANDING population (agents/semaphore.ts); this
 * bounds CHURN — a requester spawning, having agents exit, and spawning again
 * in a tight loop, which the concurrency cap cannot see because each spawn is
 * legal in isolation.
 *
 * Sliding window over a plain array, same shape as registry.ts's
 * broadcastLedger: every check prunes entries older than the window before
 * counting, so there is no separate reset timer to leak or forget.
 */

export const SPAWN_RATE_WINDOW_MS = 60_000
export const MAX_SPAWNS_PER_WINDOW = 5

export class SpawnRateBudget {
  private readonly attempts = new Map<string, number[]>()

  constructor(
    private readonly windowMs: number = SPAWN_RATE_WINDOW_MS,
    private readonly limit: number = MAX_SPAWNS_PER_WINDOW,
    private readonly now: () => number = Date.now,
  ) {}

  private ledger(requester: string): number[] {
    const cutoff = this.now() - this.windowMs
    const kept = (this.attempts.get(requester) ?? []).filter(at => at > cutoff)
    this.attempts.set(requester, kept)
    return kept
  }

  /**
   * Records the attempt and reports whether it is within budget. Charged
   * whether or not the caller goes on to refuse the spawn for some other
   * reason, or hitting the limit would make every subsequent attempt free —
   * same reasoning as the broadcast budget being spent even when suppressed.
   */
  check(requester: string): { ok: true } | { ok: false; reason: string } {
    const ledger = this.ledger(requester)
    if (ledger.length >= this.limit) {
      return {
        ok: false,
        reason:
          `${requester} has attempted ${ledger.length} spawns in the last ${this.windowMs / 1000}s ` +
          `(limit ${this.limit}); wait before spawning again`,
      }
    }
    ledger.push(this.now())
    return { ok: true }
  }
}
