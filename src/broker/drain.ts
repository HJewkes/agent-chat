/**
 * CC-1179: the broker's drain mode, which a restart enters before waiting for
 * its seam. While draining, new spawns and resumes are refused as retryable so
 * a burst during the wait costs callers nothing; work already in flight keeps
 * going until the restart finds nothing left to lose.
 *
 * The drain carries its own expiry: a restarter killed mid-wait must never
 * leave the broker refusing spawns for good.
 */

export interface DrainRefusal {
  reason: string
  retryAfterMs: number
}

export class DrainState {
  private until: number | undefined

  enter(untilMs: number): void {
    this.until = untilMs
  }

  leave(): void {
    this.until = undefined
  }

  /** The drain's expiry while it holds, undefined once left or lapsed. */
  active(now: number): { until: number } | undefined {
    if (this.until === undefined || now >= this.until) return undefined
    return { until: this.until }
  }

  refusal(now: number): DrainRefusal | undefined {
    const drain = this.active(now)
    if (drain === undefined) return undefined
    const retryAfterMs = drain.until - now
    return {
      reason: `the broker is draining for a restart; retry in ~${Math.ceil(retryAfterMs / 1000)}s`,
      retryAfterMs,
    }
  }
}
