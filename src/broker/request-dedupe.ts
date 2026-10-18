/**
 * CC-1454: answers a retried `send` or `resume` that carries the same idempotency
 * key as the first, so a client timeout does not become a second delivery or a
 * second launch. Pure: the clock is injected and the caller does every write.
 */

export const DEDUPE_TTL_MS = 10 * 60 * 1000
export const DEDUPE_MAX_ENTRIES = 2048

const NONCE = /^[A-Za-z0-9_-]{16,64}$/

/** Why a nonce is refused, or undefined when it is well formed. A CLI frame skips the tool schema, so the broker checks. */
export function nonceRefusal(nonce: string): string | undefined {
  return NONCE.test(nonce) ? undefined : 'nonce must be 16-64 characters of A-Z, a-z, 0-9, _ or -'
}

/** The requester is part of the key, so one session cannot read another's reply by replaying its key. */
export const dedupeKey = (verb: string, requester: string, nonce: string): string =>
  `${verb}\0${requester}\0${nonce}`

interface Entry<J, R> {
  fingerprint: string
  expiresAt: number
  reply?: R
  joiners: J[]
}

export type Begin<R> =
  { kind: 'run' } | { kind: 'replay'; reply: R } | { kind: 'joined' } | { kind: 'mismatch' }

export class RequestDedupe<J, R extends { ok: boolean }> {
  // Every entry is inserted or re-inserted with now + TTL, so insertion order is expiry order.
  private readonly entries = new Map<string, Entry<J, R>>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEntries: number = DEDUPE_MAX_ENTRIES,
  ) {}

  get size(): number {
    return this.entries.size
  }

  begin(key: string, fingerprint: string, joiner: J): Begin<R> {
    this.sweep()
    const entry = this.entries.get(key)
    if (entry === undefined) {
      this.insert(key, { fingerprint, expiresAt: this.now() + DEDUPE_TTL_MS, joiners: [] })
      return { kind: 'run' }
    }
    if (entry.fingerprint !== fingerprint) return { kind: 'mismatch' }
    if (entry.reply !== undefined) return { kind: 'replay', reply: entry.reply }
    entry.joiners.push(joiner)
    return { kind: 'joined' }
  }

  /**
   * Records the first request's reply and returns the joiners to answer with it.
   * A refusal is forgotten: nothing happened, so a retry should run again.
   */
  settle(key: string, reply: R): J[] {
    const entry = this.entries.get(key)
    if (entry === undefined || entry.reply !== undefined) return []
    this.entries.delete(key)
    if (reply.ok) this.insert(key, { ...entry, reply, expiresAt: this.now() + DEDUPE_TTL_MS, joiners: [] })
    return entry.joiners
  }

  /** Drops a request that ended without a reply, so a retry runs rather than waiting on it. */
  abandon(key: string): void {
    if (this.entries.get(key)?.reply === undefined) this.entries.delete(key)
  }

  private insert(key: string, entry: Entry<J, R>): void {
    this.entries.set(key, entry)
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break
      this.entries.delete(oldest)
    }
  }

  private sweep(): void {
    const now = this.now()
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt > now) break
      this.entries.delete(key)
    }
  }
}
