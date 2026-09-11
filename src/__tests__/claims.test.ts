import { describe, expect, it } from 'vitest'
import { buildOwnershipManifest, checkConflicts } from '../agents/isolation/file-ownership.js'
import { ClaimLedger, patternsOverlap } from '../broker/claims.js'

/**
 * CC-56: peers sharing a checkout had no way to ask what another had open, so
 * every negotiation in CC-46 Wave 1 happened as prose and went stale. The rule
 * these hold to is that the WORKTREE is the unit of collision — two worktrees of
 * one repo editing one path is ordinary branch work, not a conflict.
 */

const WT = '/repo/main'
const OTHER = '/repo/feature'
const REPO = '/repo'

describe('patternsOverlap', () => {
  it('catches a subtree pattern covering a concrete file', () => {
    // The single most likely real overlap, and the one file-ownership.ts's
    // string-equality check misses entirely.
    expect(patternsOverlap('src/**', 'src/cli/foo.ts')).toBe(true)
  })

  it('catches two subtree patterns where one contains the other', () => {
    expect(patternsOverlap('src/**', 'src/cli/**')).toBe(true)
  })

  it('treats identical patterns as overlapping', () => {
    expect(patternsOverlap('src/a.ts', 'src/a.ts')).toBe(true)
  })

  it('leaves genuinely separate subtrees alone', () => {
    expect(patternsOverlap('src/cli/**', 'src/broker/**')).toBe(false)
    expect(patternsOverlap('src/a.ts', 'src/b.ts')).toBe(false)
  })

  it('does not collide two files that merely share a directory', () => {
    expect(patternsOverlap('src/cli/a.ts', 'src/cli/b.ts')).toBe(false)
  })
})

/**
 * CC-92: the two overlap implementations answer the same question differently on
 * purpose — `checkConflicts` serves a manifest one coordinator hands out, where
 * identical strings are the only reachable collision, and `patternsOverlap`
 * serves agents choosing patterns independently. Until now that was prose
 * (claims.ts:60-74) with nothing holding it true. These assert the divergence,
 * so adopting `patternsOverlap` in file-ownership.ts has to be a decision rather
 * than a silent change that leaves the comment describing code that moved.
 */
describe('divergence from file-ownership checkConflicts', () => {
  const conflictsOn = (a: string, b: string): boolean =>
    checkConflicts(
      buildOwnershipManifest([
        { agentId: 'alice', patterns: [a] },
        { agentId: 'bob', patterns: [b] },
      ]),
    ).length > 0

  it('disagrees where a subtree pattern covers a concrete file', () => {
    expect(patternsOverlap('src/**', 'src/cli/foo.ts')).toBe(true)
    expect(conflictsOn('src/**', 'src/cli/foo.ts')).toBe(false)
  })

  it('disagrees where one subtree pattern contains another', () => {
    expect(patternsOverlap('src/**', 'src/cli/**')).toBe(true)
    expect(conflictsOn('src/**', 'src/cli/**')).toBe(false)
  })

  it('agrees only where the two patterns are the identical string', () => {
    expect(patternsOverlap('src/a.ts', 'src/a.ts')).toBe(true)
    expect(conflictsOn('src/a.ts', 'src/a.ts')).toBe(true)
  })
})

describe('ClaimLedger', () => {
  const ledger = () => new ClaimLedger(() => 1_000)

  it('grants an uncontested file claim', () => {
    const out = ledger().claim({ owner: 'alice', worktreePath: WT, patterns: ['src/cli/**'] })

    expect(out.ok).toBe(true)
    if (out.ok) expect(out.claim.kind).toBe('files')
  })

  it('treats a claim with no patterns as owning the whole worktree', () => {
    const out = ledger().claim({ owner: 'alice', worktreePath: WT })

    expect(out.ok).toBe(true)
    if (out.ok) expect(out.claim.kind).toBe('worktree')
  })

  it('refuses an overlapping claim and names who is in the way', () => {
    const l = ledger()
    l.claim({ owner: 'alice', worktreePath: WT, patterns: ['src/**'] })

    const out = l.claim({ owner: 'bob', worktreePath: WT, patterns: ['src/cli/foo.ts'] })

    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.reason).toContain('alice')
      expect(out.conflicts[0]?.owner).toBe('alice')
    }
  })

  it('says plainly that a claim is advisory, not a lock', () => {
    // A refusal that reads like enforcement would be a lie: nothing here
    // intercepts a write.
    const l = ledger()
    l.claim({ owner: 'alice', worktreePath: WT, patterns: ['src/**'] })

    const out = l.claim({ owner: 'bob', worktreePath: WT, patterns: ['src/**'] })

    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toMatch(/advisory/i)
  })

  it('lets two agents hold disjoint patterns in one worktree', () => {
    // The case worktree-level locking alone would refuse, and the reason file
    // granularity exists at all.
    const l = ledger()
    l.claim({ owner: 'alice', worktreePath: WT, patterns: ['src/cli/**'] })

    expect(l.claim({ owner: 'bob', worktreePath: WT, patterns: ['src/broker/**'] }).ok).toBe(true)
  })

  it('lets the same path be claimed in a different worktree of the same repo', () => {
    // THE central rule: that is two branches, which git reconciles at merge.
    const l = ledger()
    l.claim({ owner: 'alice', worktreePath: WT, repoPath: REPO, patterns: ['src/a.ts'] })

    expect(l.claim({ owner: 'bob', worktreePath: OTHER, repoPath: REPO, patterns: ['src/a.ts'] }).ok).toBe(
      true,
    )
  })

  it('makes a whole-worktree claim exclusive against file claims', () => {
    const l = ledger()
    l.claim({ owner: 'alice', worktreePath: WT })

    expect(l.claim({ owner: 'bob', worktreePath: WT, patterns: ['docs/x.md'] }).ok).toBe(false)
  })

  it('refuses a whole-worktree claim when someone holds any file in it', () => {
    const l = ledger()
    l.claim({ owner: 'alice', worktreePath: WT, patterns: ['docs/x.md'] })

    expect(l.claim({ owner: 'bob', worktreePath: WT }).ok).toBe(false)
  })

  it('replaces an owner’s own claim rather than stacking a second', () => {
    // Patterns narrow and widen as work moves; a ledger that only grew would
    // describe where an agent had been rather than where it is.
    const l = ledger()
    l.claim({ owner: 'alice', worktreePath: WT, patterns: ['src/**'] })

    const out = l.claim({ owner: 'alice', worktreePath: WT, patterns: ['src/cli/**'] })

    expect(out.ok).toBe(true)
    if (out.ok) expect(out.replaced).toBe(true)
    expect(l.inWorktree(WT)).toHaveLength(1)
    expect(l.inWorktree(WT)[0]?.patterns).toEqual(['src/cli/**'])
  })

  it('refuses a second worktree of the same repo for one owner', () => {
    const l = ledger()
    l.claim({ owner: 'alice', worktreePath: WT, repoPath: REPO, patterns: ['src/**'] })

    const out = l.claim({ owner: 'alice', worktreePath: OTHER, repoPath: REPO, patterns: ['docs/**'] })

    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toMatch(/one worktree per repo/i)
  })

  it('allows one owner to hold worktrees in different repositories', () => {
    // An agent working across several projects at once is normal and supported.
    const l = ledger()
    l.claim({ owner: 'alice', worktreePath: '/a/main', repoPath: '/a', patterns: ['src/**'] })

    expect(
      l.claim({ owner: 'alice', worktreePath: '/b/main', repoPath: '/b', patterns: ['src/**'] }).ok,
    ).toBe(true)
  })

  it('frees everything an owner held when its connection goes', () => {
    // What makes a claim a lease held by presence: nothing to reap, nothing
    // stale, and a dead agent stops blocking its peers at once.
    const l = ledger()
    l.claim({ owner: 'alice', worktreePath: '/a/main', repoPath: '/a', patterns: ['src/**'] })
    l.claim({ owner: 'alice', worktreePath: '/b/main', repoPath: '/b' })

    expect(l.releaseAll('alice')).toBe(true)
    expect(l.list()).toHaveLength(0)
    expect(l.claim({ owner: 'bob', worktreePath: '/a/main', patterns: ['src/**'] }).ok).toBe(true)
  })

  it('releases one worktree without touching the owner’s others', () => {
    const l = ledger()
    l.claim({ owner: 'alice', worktreePath: '/a/main', repoPath: '/a', patterns: ['src/**'] })
    l.claim({ owner: 'alice', worktreePath: '/b/main', repoPath: '/b', patterns: ['src/**'] })

    expect(l.releaseIn('alice', '/a/main')).toBe(true)
    expect(l.list().map(c => c.worktreePath)).toEqual(['/b/main'])
  })

  it('reports nothing released when the owner held nothing', () => {
    expect(ledger().releaseAll('nobody')).toBe(false)
  })
})
