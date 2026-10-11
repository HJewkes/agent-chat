import { describe, expect, it } from 'vitest'
import type { Refusal } from '../agents/burndown/eligibility.js'
import { noDispatchReason } from '../agents/burndown/no-dispatch.js'
import { loadTickConfig } from '../agents/burndown/source.js'
import { canonicalTag, scopeRefusal, type SeatScope } from '../agents/burndown/seat-scope.js'

const ALIASES = { spine: 'milestone' }
const scopeOf = (tags: string[], aliases?: Record<string, string>): SeatScope => ({
  tags,
  shared: ['alpha'],
  backlog: new Set(),
  ...(aliases === undefined ? {} : { aliases }),
})
const refusal = (scope: SeatScope, id: string, tags: string[]) => scopeRefusal(scope, 'alpha', { id, tags })

describe('scope tag aliases (CC-945)', () => {
  it('canonicalises a spine tag to the milestone family and leaves other tags alone', () => {
    expect(canonicalTag('spine:M3', ALIASES)).toBe('milestone:M3')
    expect(canonicalTag('milestone:M3', ALIASES)).toBe('milestone:M3')
    expect(canonicalTag('lane:a', ALIASES)).toBe('lane:a')
    expect(canonicalTag('spine:M3', undefined)).toBe('spine:M3')
  })

  it('takes a milestone task for a seat scoped to spine, and the reverse', () => {
    expect(refusal(scopeOf(['spine:M3'], ALIASES), 'T-1', ['milestone:M3'])).toBeUndefined()
    expect(refusal(scopeOf(['milestone:M3'], ALIASES), 'T-1', ['spine:M3'])).toBeUndefined()
  })

  it('still refuses another milestone, and both spellings without an alias map', () => {
    expect(refusal(scopeOf(['spine:M3'], ALIASES), 'T-1', ['milestone:M9'])).toMatch(/none of scope_tags/)
    expect(refusal(scopeOf(['spine:M3']), 'T-1', ['milestone:M3'])).toMatch(/none of scope_tags/)
  })

  it('defaults the config map to spine -> milestone', () => {
    expect(loadTickConfig('/nonexistent/burndown.config.json').scopeTagAliases).toEqual(ALIASES)
  })

  it('replays a tick where 700 tasks carried milestone tags against spine scope_tags: out-of-scope falls from 660 to under 50', () => {
    const seatTags = ['spine:M3', 'spine:M4', 'spine:F-lane']
    const tasks = Array.from({ length: 700 }, (_, i) => ({
      id: `T-${i}`,
      tags: [i < 660 ? `milestone:${['M3', 'M4', 'F-lane'][i % 3]}` : 'milestone:M9'],
    }))
    const count = (scope: SeatScope) => tasks.filter(t => refusal(scope, t.id, t.tags) !== undefined).length

    expect(count(scopeOf(seatTags))).toBe(700)
    expect(count(scopeOf(seatTags, ALIASES))).toBe(40)
  })

  it('names the first five out-of-scope ids with their tags in the dispatched-nothing line', () => {
    const refusals: Refusal[] = Array.from({ length: 7 }, (_, i) => ({
      initiative: 'alpha',
      task: `T-${i}`,
      kind: 'out-of-scope',
      reason: 'r',
      tags: i === 1 ? [] : ['milestone:M9'],
    }))

    const text = noDispatchReason({ seat: 's', dispatched: 0, refusals })?.text

    expect(text).toContain('out-of-scope 7')
    expect(text).toContain(
      'out-of-scope first 5: T-0 [milestone:M9], T-1 [no tags], T-2 [milestone:M9], T-3 [milestone:M9], T-4 [milestone:M9]',
    )
    expect(text).not.toContain('T-5')
  })
})
