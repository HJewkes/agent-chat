import { randomUUID } from 'node:crypto'

/**
 * CC-1454: the idempotency key a client puts on a `send` or `resume`. A retry of
 * a request that timed out reuses that request's key, so the broker answers it
 * from its cache instead of delivering or launching a second time. Every other
 * request gets a fresh key. Pure: the clock and the minting are injected.
 */

export const RETRY_KEY_TTL_MS = 10 * 60 * 1000
export const RETRY_KEY_MAX_ENTRIES = 64

const mintKey = (): string => randomUUID().replaceAll('-', '')

interface Remembered {
  key: string
  expiresAt: number
}

export class RetryKeys {
  // Every entry is inserted with now + TTL, so insertion order is expiry order.
  private readonly keys = new Map<string, Remembered>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly mint: () => string = mintKey,
    private readonly maxEntries: number = RETRY_KEY_MAX_ENTRIES,
  ) {}

  /** The key of an identical request that timed out within the TTL, else a fresh one. */
  keyFor(fingerprint: string): string {
    this.sweep()
    return this.keys.get(fingerprint)?.key ?? this.mint()
  }

  rememberTimedOut(fingerprint: string, key: string): void {
    this.keys.delete(fingerprint)
    this.keys.set(fingerprint, { key, expiresAt: this.now() + RETRY_KEY_TTL_MS })
    for (const oldest of this.keys.keys()) {
      if (this.keys.size <= this.maxEntries) break
      this.keys.delete(oldest)
    }
  }

  /** The broker answered, so a later identical request is a new one and gets a new key. */
  settled(fingerprint: string): void {
    this.keys.delete(fingerprint)
  }

  private sweep(): void {
    const now = this.now()
    for (const [fingerprint, entry] of this.keys) {
      if (entry.expiresAt > now) break
      this.keys.delete(fingerprint)
    }
  }
}
