import { describe, expect, it } from 'vitest'
import { bandFor, ContextHinter, THRESHOLDS, withHint } from '../server/context-hint.js'
import type { BudgetRead } from '../agents/budget.js'

const read =
  (pct: number | undefined, over: Partial<Extract<BudgetRead, { found: true }>> = {}) =>
  (): BudgetRead =>
    ({
      found: true,
      path: '/cache/s.json',
      age_seconds: 1,
      stale: false,
      budget: {
        session_id: 's',
        cwd: '/repo',
        written_at: 0,
        context: { ...(pct === undefined ? {} : { used_pct: pct }) },
        rate_limits: {},
      },
      ...over,
    }) as BudgetRead

const missing = (): BudgetRead => ({ found: false, path: '/cache/s.json', reason: 'no_file' }) as BudgetRead

describe('bandFor', () => {
  it('reports the highest crossed threshold, and nothing below the first', () => {
    expect(bandFor(0)).toBeUndefined()
    expect(bandFor(69)).toBeUndefined()
    expect(bandFor(70)).toBe(70)
    expect(bandFor(84)).toBe(70)
    expect(bandFor(85)).toBe(85)
    expect(bandFor(99)).toBe(95)
  })

  it('has thresholds in ascending order, since bandFor reverses them', () => {
    expect([...THRESHOLDS]).toEqual([...THRESHOLDS].sort((a, b) => a - b))
  })
})

describe('ContextHinter', () => {
  it('says nothing below the first threshold', () => {
    expect(new ContextHinter('s', read(40)).hint()).toBeUndefined()
  })

  it('names the action, not just the number', () => {
    // CC-84: an agent acts on instruction text far more reliably than on ambient
    // data. A bare percentage is data; naming the tool is a thing to do.
    const hint = new ContextHinter('s', read(86)).hint()
    expect(hint).toContain('86%')
    expect(hint).toContain('agent_teleport')
  })

  it('announces each crossing once, so a hint never becomes noise', () => {
    const hinter = new ContextHinter('s', read(86))
    expect(hinter.hint()).toBeDefined()
    expect(hinter.hint()).toBeUndefined()
    expect(hinter.hint()).toBeUndefined()
  })

  it('speaks again when a HIGHER band is crossed', () => {
    let pct = 72
    const hinter = new ContextHinter('s', () => read(pct)())
    expect(hinter.hint()).toBeDefined()
    pct = 96
    const escalated = hinter.hint()
    expect(escalated).toBeDefined()
    // The top band is the one place the advice changes from "plan a stopping
    // point" to "stop now", because past it the summarising runs out of room.
    expect(escalated).toMatch(/Wrap now/)
  })

  it('stays quiet when the figure is STALE rather than hinting off a dead number', () => {
    expect(new ContextHinter('s', read(90, { stale: true })).hint()).toBeUndefined()
  })

  it('stays quiet when no figure is published at all', () => {
    // The status-line writer is an opt-in install (CC-85). A machine without it
    // must simply never hint, not hint wrongly.
    expect(new ContextHinter('s', missing).hint()).toBeUndefined()
    expect(new ContextHinter('s', read(undefined)).hint()).toBeUndefined()
  })

  it('stays quiet with no session id, which is every non-session MCP server', () => {
    expect(new ContextHinter(undefined, read(99)).hint()).toBeUndefined()
  })

  it('re-arms when the reading drops back below a band, which is what a teleport looks like', () => {
    let pct = 96
    const hinter = new ContextHinter('s', () => read(pct)())
    expect(hinter.hint()).toBeDefined()
    pct = 10
    expect(hinter.hint()).toBeUndefined()
    pct = 88
    expect(hinter.hint()).toBeDefined()
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
