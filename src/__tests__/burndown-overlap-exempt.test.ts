import { describe, expect, it } from 'vitest'
import {
  collision,
  collisionCheck,
  type CollisionFacts,
  type CollisionWork,
} from '../agents/burndown/collision.js'
import type { Runner } from '../agents/burndown/exec.js'
import {
  DEFAULT_OVERLAP_EXEMPT,
  SHARED_DOC_EXEMPT,
  overlapExemptFor,
} from '../agents/burndown/overlap-exempt.js'

/** CC-1153: index and generated files that merge-up resolves never refuse a dispatch on overlap alone. */

const TITAN = '/x/titan-platform'
const AGENT_CHAT = '/x/agent-chat'
const README = 'products/factory/README.md'

const facts = (over: Partial<CollisionFacts> = {}): CollisionFacts => ({
  repo: TITAN,
  subjects: [],
  prs: [],
  prFiles: () => [],
  names: [],
  claims: [],
  ours: new Set(),
  held: [],
  heldOwns: [],
  overlapExempt: overlapExemptFor(TITAN, {}),
  ...over,
})

const work = (owns: string[]): CollisionWork => ({ taskId: 'TP-1', slice: 'a', tags: [], owns })

const openPrTouching = (files: string[]): Partial<CollisionFacts> => ({
  prs: [{ number: 1261, title: 'Other work', branch: 'feat/other', body: '' }],
  prFiles: () => files,
})

describe('dispatch file-overlap gate with an exempt list', () => {
  it('dispatches when an open PR overlaps only on the factory README index', () => {
    const found = collision(work([README, 'src/x.ts']), facts(openPrTouching([README])))

    expect(found).toBeUndefined()
  })

  it('still refuses when the same PR also touches a real source file', () => {
    const found = collision(work([README, 'src/x.ts']), facts(openPrTouching([README, 'src/x.ts'])))

    expect(found).toEqual({ kind: 'file-overlap', reason: '#1261 touches src/x.ts' })
  })

  it('dispatches over a held claim whose owns overlap only on a nested CAPABILITIES.md', () => {
    const heldOwns = [{ holder: 'TP-2 slice a', repo: TITAN, owns: ['packages/a/CAPABILITIES.md'] }]

    expect(collision(work(['packages/a/CAPABILITIES.md']), facts({ heldOwns }))).toBeUndefined()
  })

  it('still refuses a held claim overlapping on run-tick.ts', () => {
    const heldOwns = [{ holder: 'TP-2 slice a', repo: TITAN, owns: ['src/run-tick.ts'] }]

    expect(collision(work(['src/run-tick.ts', 'CAPABILITIES.md']), facts({ heldOwns }))).toEqual({
      kind: 'file-overlap',
      reason: "src/run-tick.ts is under TP-2 slice a's owns",
    })
  })

  it('still refuses a broker file claim on an exempt path', () => {
    const claims = [{ owner: 'someone', repo: TITAN, patterns: [README] }]

    expect(collision(work([README]), facts({ claims }))?.kind).toBe('claimed')
  })

  it('applies no exemption in a repo without a list', () => {
    const found = collision(
      work([README]),
      facts({ repo: '/x/agent-chat', overlapExempt: [], ...openPrTouching([README]) }),
    )

    expect(found?.kind).toBe('file-overlap')
  })

  it('collisionCheck reads the exempt list for the repo it checks', () => {
    const exec: Runner = (bin, args) => {
      if (bin !== 'gh') return { status: 0, stdout: args[0] === 'log' ? 'init\n' : '' }
      if (args[2]?.includes('/files')) return { status: 0, stdout: `${README}\n` }
      return { status: 0, stdout: JSON.stringify({ number: 7, title: 'x', branch: 'feat/x', body: '' }) }
    }
    const asked: string[] = []
    const check = collisionCheck(
      { version: 1, claims: [] },
      { names: [], claims: [] },
      exec,
      undefined,
      repo => {
        asked.push(repo)
        return [README]
      },
    )

    expect(check(TITAN, work([README]))).toBeUndefined()
    expect(asked).toEqual([TITAN])
  })
})

describe('shared docs in a repo with no list of its own', () => {
  const agentChat = (over: Partial<CollisionFacts> = {}): CollisionFacts =>
    facts({ repo: AGENT_CHAT, overlapExempt: overlapExemptFor(AGENT_CHAT, {}), ...over })
  const docs = ['README.md', 'docs/README-dev.md', 'CAPABILITIES.md']

  it('dispatches when an open PR overlaps only on a root README, a nested README variant and CAPABILITIES.md', () => {
    expect(collision(work([...docs, 'src/a.ts']), agentChat(openPrTouching(docs)))).toBeUndefined()
  })

  it('still refuses when that PR also touches the code file', () => {
    const found = collision(work([...docs, 'src/a.ts']), agentChat(openPrTouching([...docs, 'src/a.ts'])))

    expect(found).toEqual({ kind: 'file-overlap', reason: '#1261 touches src/a.ts' })
  })

  it('dispatches over a held claim that owns a changeset glob', () => {
    const heldOwns = [{ holder: 'CC-2 slice a', repo: AGENT_CHAT, owns: ['.changeset/*.md', 'src/b.ts'] }]

    expect(collision(work(['.changeset/tp-x.md', 'src/a.ts']), agentChat({ heldOwns }))).toBeUndefined()
  })

  it('still refuses a held claim that shares the code file', () => {
    const heldOwns = [{ holder: 'CC-2 slice a', repo: AGENT_CHAT, owns: ['README.md', 'src/a.ts'] }]

    expect(collision(work(['README.md', 'src/a.ts']), agentChat({ heldOwns }))?.kind).toBe('file-overlap')
  })
})

describe('overlapExemptFor', () => {
  it('returns the shared docs plus the built-in titan-platform list when config names none', () => {
    expect(overlapExemptFor(TITAN, {})).toEqual([
      ...SHARED_DOC_EXEMPT,
      ...(DEFAULT_OVERLAP_EXEMPT['titan-platform'] ?? []),
    ])
    expect(overlapExemptFor(TITAN, {})).toContain('site/reference/**')
  })

  it('lets config replace only the repo part of the list', () => {
    const config = { dispatchOverlapExempt: { 'titan-platform': ['a.md'] } }

    expect(overlapExemptFor(TITAN, config)).toEqual([...SHARED_DOC_EXEMPT, 'a.md'])
    expect(overlapExemptFor(TITAN, config)).toContain('**/CAPABILITIES.md')
  })

  it('returns the shared docs for a repo with no default and no config', () => {
    expect(overlapExemptFor(AGENT_CHAT, {})).toEqual(['**/CAPABILITIES.md', '**/README*.md', '.changeset/**'])
  })

  it.each([['not a list'], [[1, 2]], [null]])('keeps the default when the configured value is %j', value => {
    const config = { dispatchOverlapExempt: { 'titan-platform': value } }

    expect(overlapExemptFor(TITAN, config)).toEqual(overlapExemptFor(TITAN, {}))
  })
})
