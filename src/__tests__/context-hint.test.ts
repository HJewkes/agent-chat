import { describe, expect, it } from 'vitest'
import { cacheSentence, ContextHinter, thresholdFor, withHint } from '../server/context-hint.js'
import type { BudgetRead, PromptCache, SessionBudget } from '../agents/budget.js'
import type { ContextHintPolicy } from '../config.js'

const NOW = 1_790_000_000_000
const implementer: ContextHintPolicy = { tokens: 200_000, boundary: 'natural stopping point' }

const read =
  (
    tokens: number | undefined,
    over: { stale?: boolean; context?: Partial<SessionBudget['context']>; prompt_cache?: PromptCache } = {},
  ) =>
  (): BudgetRead =>
    ({
      found: true,
      path: '/cache/s.json',
      age_seconds: 1,
      stale: over.stale ?? false,
      budget: {
        session_id: 's',
        cwd: '/repo',
        written_at: 0,
        context: {
          exceeds_200k: false,
          window_size: 1_000_000,
          ...(tokens === undefined ? {} : { input_tokens: tokens }),
          ...over.context,
        },
        cost: {},
        rate_limits: {},
        ...(over.prompt_cache ? { prompt_cache: over.prompt_cache } : {}),
      },
    }) as BudgetRead

const missing = (): BudgetRead => ({ found: false, path: '/cache/s.json', reason: 'no_file' }) as BudgetRead

const hinter = (reader: () => BudgetRead, policy: ContextHintPolicy | null = implementer) =>
  new ContextHinter('s', policy, reader, () => NOW)

describe('thresholdFor', () => {
  it('uses the role number on a window large enough to reach it', () => {
    expect(thresholdFor(implementer, 1_000_000)).toBe(200_000)
  })

  it('falls back to 85% of a window too small to reach the role number', () => {
    expect(thresholdFor({ tokens: 250_000, boundary: 'x' }, 200_000)).toBe(170_000)
  })
})

describe('ContextHinter', () => {
  it('says nothing below the role threshold, however large the window', () => {
    expect(hinter(read(199_000)).hint()).toBeUndefined()
  })

  it('fires on absolute tokens where percent-of-window would have stayed silent', () => {
    // 210k of a 1M window is 21%, far below the old 70% band.
    const hint = hinter(read(210_000)).hint()

    expect(hint).toContain('210k tokens')
    expect(hint).toContain('200k advisory mark')
    expect(hint).toContain('agent_teleport')
  })

  it('derives tokens from percent and window when the writer sent no token count', () => {
    const hint = hinter(read(undefined, { context: { used_pct: 26, window_size: 1_000_000 } }), {
      tokens: 250_000,
      boundary: 'episode boundary',
    }).hint()

    expect(hint).toContain('260k tokens')
    expect(hint).toContain('At your next episode boundary')
  })

  it('never hints a role whose policy is null', () => {
    expect(hinter(read(900_000), null).hint()).toBeUndefined()
  })

  it('announces the crossing once, so a hint never becomes noise', () => {
    const h = hinter(read(250_000))
    expect(h.hint()).toBeDefined()
    expect(h.hint()).toBeUndefined()
  })

  it('re-arms when the reading drops back below the threshold, which is what a teleport looks like', () => {
    let tokens = 250_000
    const h = hinter(() => read(tokens)())
    expect(h.hint()).toBeDefined()
    tokens = 20_000
    expect(h.hint()).toBeUndefined()
    tokens = 220_000
    expect(h.hint()).toBeDefined()
  })

  it('stays quiet when the figure is STALE rather than hinting off a dead number', () => {
    expect(hinter(read(900_000, { stale: true })).hint()).toBeUndefined()
  })

  it('stays quiet when no figure is published at all', () => {
    expect(hinter(missing).hint()).toBeUndefined()
    expect(hinter(read(undefined)).hint()).toBeUndefined()
  })

  it('stays quiet with no session id, which is every non-session MCP server', () => {
    expect(new ContextHinter(undefined, implementer, read(900_000)).hint()).toBeUndefined()
  })

  it('carries a warm cache and its remaining time into the hint', () => {
    const cache = { warm: true, caching_observed: true, expires_at: NOW / 1000 + 240 }

    expect(hinter(read(210_000, { prompt_cache: cache })).hint()).toMatch(
      /warm for about 4 more min: hand off while it is still warm/,
    )
  })

  it('omits cache state entirely when the status line did not report it', () => {
    expect(hinter(read(210_000)).hint()).not.toMatch(/cache/)
  })
})

describe('cacheSentence', () => {
  it('reads a warm flag whose expiry already passed as cold, so an idle gap is no reason to hurry', () => {
    const expired = { warm: true, caching_observed: true, expires_at: NOW / 1000 - 1 }

    expect(cacheSentence(expired, NOW)).toMatch(/already gone cold, so there is no rush/)
  })

  it('says nothing when caching was never observed', () => {
    expect(cacheSentence({ warm: false, caching_observed: false }, NOW)).toBeUndefined()
  })

  it('says warm without a time when no expiry was reported', () => {
    expect(cacheSentence({ warm: true }, NOW)).toBe(
      'Your prompt cache is warm: hand off while it is still warm.',
    )
  })
})

describe('withHint', () => {
  it('leaves the message untouched when there is nothing to say', () => {
    expect(withHint('hello', undefined)).toBe('hello')
  })

  it('keeps the hint visually separate from the peer message it rides', () => {
    // The message is a peer's words and the hint is not. They must not read as
    // one paragraph, or the hint inherits the peer's voice.
    expect(withHint('hello', '[budget] x')).toBe('hello\n\n[budget] x')
  })
})
