import { describe, expect, it } from 'vitest'
import { DEDUPE_TTL_MS, RequestDedupe, dedupeKey, nonceRefusal } from '../broker/request-dedupe.js'
import { requestFingerprint } from '../protocol-fingerprint.js'

/** CC-1454: the broker's cache of keyed requests, on a clock the test moves. */

const MINUTE = 60_000
const OK = { ok: true, msgId: 'aaaaaaaa' }

function clocked(maxEntries?: number) {
  let now = 1_000_000
  const dedupe = new RequestDedupe<string, { ok: boolean; msgId?: string }>(() => now, maxEntries)
  return { dedupe, at: (ms: number) => void (now = 1_000_000 + ms) }
}

describe('a settled request', () => {
  it('replays for ten minutes after it settled and runs again after', () => {
    const { dedupe, at } = clocked()
    dedupe.begin('k', 'fp', 'first')
    at(5 * MINUTE)
    dedupe.settle('k', OK)

    at(5 * MINUTE + DEDUPE_TTL_MS - 1)
    const late = dedupe.begin('k', 'fp', 'retry')
    at(5 * MINUTE + DEDUPE_TTL_MS + 1)
    const expired = dedupe.begin('k', 'fp', 'retry')

    expect(late).toEqual({ kind: 'replay', reply: OK })
    expect(expired).toEqual({ kind: 'run' })
  })

  it('forgets a refusal, so the retry runs', () => {
    const { dedupe } = clocked()
    dedupe.begin('k', 'fp', 'first')

    dedupe.settle('k', { ok: false })

    expect(dedupe.begin('k', 'fp', 'retry')).toEqual({ kind: 'run' })
  })

  it('keeps the first reply when a second settle arrives', () => {
    const { dedupe } = clocked()
    dedupe.begin('k', 'fp', 'first')
    dedupe.settle('k', OK)

    dedupe.settle('k', { ok: true, msgId: 'bbbbbbbb' })

    expect(dedupe.begin('k', 'fp', 'retry')).toEqual({ kind: 'replay', reply: OK })
  })
})

describe('a pending request', () => {
  it('joins a retry and hands it to settle, not to begin', () => {
    const { dedupe } = clocked()
    dedupe.begin('k', 'fp', 'first')

    const joined = dedupe.begin('k', 'fp', 'retry')
    const answered = dedupe.settle('k', OK)

    expect(joined).toEqual({ kind: 'joined' })
    expect(answered).toEqual(['retry'])
  })

  it('runs a retry after the first ended without a reply', () => {
    const { dedupe } = clocked()
    dedupe.begin('k', 'fp', 'first')

    dedupe.abandon('k')

    expect(dedupe.begin('k', 'fp', 'retry')).toEqual({ kind: 'run' })
  })
})

describe('a key reused for a different request', () => {
  it('is a mismatch, pending or settled', () => {
    const { dedupe } = clocked()
    dedupe.begin('k', 'fp', 'first')
    const pending = dedupe.begin('k', 'other', 'retry')
    dedupe.settle('k', OK)

    expect(pending).toEqual({ kind: 'mismatch' })
    expect(dedupe.begin('k', 'other', 'retry')).toEqual({ kind: 'mismatch' })
  })
})

describe('the entry cap', () => {
  it('evicts the oldest key once it is full', () => {
    const { dedupe } = clocked(4)
    for (const key of ['k0', 'k1', 'k2', 'k3', 'k4']) dedupe.begin(key, 'fp', key)

    expect(dedupe.size).toBe(4)
    expect(dedupe.begin('k0', 'fp', 'retry')).toEqual({ kind: 'run' })
    expect(dedupe.begin('k4', 'fp', 'retry')).toEqual({ kind: 'joined' })
  })

  it('holds 2,048 entries by default', () => {
    const { dedupe } = clocked()
    for (let i = 0; i <= 2048; i++) dedupe.begin(`k${i}`, 'fp', 'first')

    expect(dedupe.size).toBe(2048)
    expect(dedupe.begin('k0', 'fp', 'retry')).toEqual({ kind: 'run' })
  })
})

describe('nonces and keys', () => {
  it('accepts 16-64 url-safe characters and refuses anything else', () => {
    expect(nonceRefusal('a'.repeat(16))).toBeUndefined()
    expect(nonceRefusal('A_-9'.repeat(16))).toBeUndefined()
    expect(nonceRefusal('a'.repeat(15))).toBeDefined()
    expect(nonceRefusal('a'.repeat(65))).toBeDefined()
    expect(nonceRefusal(`${'a'.repeat(16)}\n`)).toBeDefined()
  })

  it('scopes a key to its verb and requester', () => {
    const keys = new Set([
      dedupeKey('send', 'scout', 'n'),
      dedupeKey('resume', 'scout', 'n'),
      dedupeKey('send', 'agent-x', 'n'),
    ])

    expect(keys.size).toBe(3)
  })
})

describe('the request fingerprint', () => {
  it('ignores the nonce and changes with the text', () => {
    const base = { t: 'send', to: 'agent-x', text: 'hi' } as const

    expect(requestFingerprint({ ...base, nonce: 'a'.repeat(16) })).toBe(requestFingerprint(base))
    expect(requestFingerprint({ ...base, text: 'bye' })).not.toBe(requestFingerprint(base))
    expect(requestFingerprint(base)).toMatch(/^[0-9a-f]{32}$/)
  })

  it('changes with the message a resume carries', () => {
    const base = { t: 'resume', name: 'seat-x' } as const

    expect(requestFingerprint({ ...base, message: 'go on' })).not.toBe(requestFingerprint(base))
  })
})
