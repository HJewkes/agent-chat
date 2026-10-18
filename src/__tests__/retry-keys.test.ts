import { describe, expect, it } from 'vitest'
import { RETRY_KEY_TTL_MS, RetryKeys } from '../client/retry-keys.js'

/** CC-1454: a timed-out request's key is reused by an identical retry, and only by one. */

function keys(maxEntries?: number): { retryKeys: RetryKeys; clock: { now: number } } {
  const clock = { now: 1_000 }
  let minted = 0
  const retryKeys = new RetryKeys(
    () => clock.now,
    () => `key-${String(++minted).padStart(16, '0')}`,
    maxEntries,
  )
  return { retryKeys, clock }
}

describe('RetryKeys', () => {
  it('mints a new key for each request that has not timed out', () => {
    const { retryKeys } = keys()

    expect(retryKeys.keyFor('fp')).not.toBe(retryKeys.keyFor('fp'))
  })

  it('reuses a timed-out key for an identical request until the TTL passes', () => {
    const { retryKeys, clock } = keys()
    const first = retryKeys.keyFor('fp')
    retryKeys.rememberTimedOut('fp', first)

    clock.now += RETRY_KEY_TTL_MS - 1
    expect(retryKeys.keyFor('fp')).toBe(first)
    clock.now += 1
    expect(retryKeys.keyFor('fp')).not.toBe(first)
  })

  it('forgets the key once the broker answers, so a later deliberate resend is a new request', () => {
    const { retryKeys } = keys()
    const first = retryKeys.keyFor('fp')
    retryKeys.rememberTimedOut('fp', first)

    retryKeys.settled('fp')

    expect(retryKeys.keyFor('fp')).not.toBe(first)
  })

  it('does not lend a key to a request with a different fingerprint', () => {
    const { retryKeys } = keys()
    const first = retryKeys.keyFor('fp-a')
    retryKeys.rememberTimedOut('fp-a', first)

    expect(retryKeys.keyFor('fp-b')).not.toBe(first)
  })

  it('drops the oldest remembered key past the cap', () => {
    const { retryKeys } = keys(2)
    for (const fp of ['a', 'b', 'c']) retryKeys.rememberTimedOut(fp, `kept-${fp}`)

    expect(retryKeys.keyFor('a')).not.toBe('kept-a')
    expect(retryKeys.keyFor('c')).toBe('kept-c')
  })
})
