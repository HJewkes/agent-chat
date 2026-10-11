import { matchPattern } from '../agents/isolation/file-ownership.js'

/**
 * Who is working on what, at a granularity finer than "which session exists"
 * (CC-56).
 *
 * `chat_list` answers who is registered and what they SAY they are doing. Every
 * real negotiation in CC-46 Wave 1 — package.json sequencing, an api-contract.ts
 * change landing mid-wave with nobody told — happened over prose because there
 * was no way to ask "what does that peer have open right now". All three peers
 * raised it independently in the retro, which is about as clear a signal as a
 * retro produces.
 *
 * WHY NOT JUST READ GIT. A working tree has one status, not one per session, so
 * `git status` in a shared checkout returns the same list to everybody and can
 * attribute nothing. It reports the symptom of the problem and none of its
 * structure. A claim is the missing half: a statement of INTENT, made before the
 * edit rather than discovered after it.
 *
 * THE SCOPE IS THE WORKTREE, and that is the whole design. Two agents in two
 * worktrees of one repository editing the same path are not in conflict — they
 * are on two branches, and git reconciles them at merge. Scoping claims to the
 * repository would refuse that, which is normal, correct work. Scoping to the
 * worktree refuses only what genuinely cannot be reconciled: two agents writing
 * the same file in the same working tree, where the second write simply destroys
 * the first.
 *
 * ADVISORY, and it must be described that way wherever it surfaces. Nothing here
 * intercepts a file write. A refused claim tells an agent that a peer is already
 * there; it does not and cannot stop an agent that never claims at all.
 */

/** Whole-worktree ownership, or a set of path patterns inside one. */
export type ClaimKind = 'worktree' | 'files'

export interface Claim {
  owner: string
  worktreePath: string
  /**
   * The repository behind `worktreePath`. Carried so the one-worktree-per-repo
   * rule can be checked without re-running git for every claim.
   */
  repoPath?: string
  kind: ClaimKind
  /** Empty for a `worktree` claim, which owns everything in it. */
  patterns: string[]
  at: number
}

export interface ClaimRequest {
  owner: string
  worktreePath: string
  repoPath?: string
  patterns?: readonly string[]
}

export type ClaimOutcome =
  { ok: true; claim: Claim; replaced: boolean } | { ok: false; reason: string; conflicts: Claim[] }

/**
 * Do two patterns describe any of the same files?
 *
 * `checkConflicts` in file-ownership.ts compares patterns as literal STRINGS,
 * which is right for the manifest it was written for — assignments handed out by
 * one coordinator — and wrong here, where two agents pick their own patterns
 * independently. Under string equality `src/**` and `src/cli/foo.ts` do not
 * conflict, which is the single most likely real overlap.
 *
 * The decision is exact for this glob dialect (`*` within a segment, `**`
 * across segments, everything else literal): both sides describe regular
 * languages, so whether any path matches both follows from the patterns alone,
 * segment by segment, without enumerating the filesystem. A refused claim costs
 * a conversation and a missed one a silently lost edit, so the one shape this
 * does not decide (`**` inside a longer segment) is reported as an overlap.
 */
export function patternsOverlap(a: string, b: string): boolean {
  if (a === b) return true
  if (!hasWildcard(a) && !hasWildcard(b)) return matchPattern(a, b) || matchPattern(b, a)
  const [globA, globB] = [asGlob(a), asGlob(b)]
  if (isFilePath(a)) return matchPattern(a, globB)
  if (isFilePath(b)) return matchPattern(b, globA)
  return globsIntersect(globA, globB)
}

const hasWildcard = (pattern: string): boolean => pattern.includes('*')

const isFilePath = (pattern: string): boolean => !hasWildcard(pattern) && !pattern.endsWith('/')

/** A trailing-slash pattern is a directory prefix, which is what `dir/**` says. */
const asGlob = (pattern: string): string => (pattern.endsWith('/') ? `${pattern}**` : pattern)

const ANY_SEGMENTS = '**'

/**
 * A trailing `**` needs at least one segment and an interior one accepts none,
 * so the trailing form is rewritten as one `*` segment followed by the interior
 * form. Every `**` the walk sees then means "zero or more segments".
 */
function segmentsOf(glob: string): string[] {
  const segments = glob.split('/')
  return segments.at(-1) === ANY_SEGMENTS ? [...segments.slice(0, -1), '*', ANY_SEGMENTS] : segments
}

function globsIntersect(a: string, b: string): boolean {
  const [left, right] = [segmentsOf(a), segmentsOf(b)]
  const undecided = (s: string): boolean => s.includes(ANY_SEGMENTS) && s !== ANY_SEGMENTS
  if (left.some(undecided) || right.some(undecided)) return true
  return walkSegments(left, right)
}

/** Can `left[i..]` and `right[j..]` match one common path? Memoised over (i, j). */
function walkSegments(left: string[], right: string[]): boolean {
  const memo = new Map<number, boolean>()
  const from = (i: number, j: number): boolean => {
    const key = i * (right.length + 1) + j
    let result = memo.get(key)
    if (result === undefined) {
      result = step(i, j)
      memo.set(key, result)
    }
    return result
  }
  const step = (i: number, j: number): boolean => {
    if (left[i] === ANY_SEGMENTS) return from(i + 1, j) || (j < right.length && from(i, j + 1))
    if (right[j] === ANY_SEGMENTS) return from(i, j + 1) || (i < left.length && from(i + 1, j))
    if (i === left.length || j === right.length) return i === left.length && j === right.length
    return segmentsIntersect(left[i]!, right[j]!) && from(i + 1, j + 1)
  }
  return from(0, 0)
}

function segmentsIntersect(a: string, b: string): boolean {
  if (!hasWildcard(a)) return matchPattern(a, b)
  if (!hasWildcard(b)) return matchPattern(b, a)
  return starSegmentsIntersect(a, b)
}

/**
 * Two `*` segments share a name exactly when their fixed heads agree and their
 * fixed tails agree: the stars on each side can absorb the other's middle text.
 */
function starSegmentsIntersect(a: string, b: string): boolean {
  const head = (s: string): string => s.slice(0, s.indexOf('*'))
  const tail = (s: string): string => s.slice(s.lastIndexOf('*') + 1)
  const [headA, headB, tailA, tailB] = [head(a), head(b), tail(a), tail(b)]
  return (
    (headA.startsWith(headB) || headB.startsWith(headA)) && (tailA.endsWith(tailB) || tailB.endsWith(tailA))
  )
}

export class ClaimLedger {
  private readonly claims: Claim[] = []

  constructor(private readonly now: () => number = Date.now) {}

  /** Every live claim, newest last. */
  list(): Claim[] {
    return [...this.claims]
  }

  /** Live claims in one worktree. */
  inWorktree(worktreePath: string): Claim[] {
    return this.claims.filter(c => c.worktreePath === worktreePath)
  }

  /**
   * Take a claim, or refuse it and say who is in the way.
   *
   * An owner re-claiming in a worktree it already holds REPLACES its own claim
   * rather than stacking a second one: patterns get narrowed and widened as work
   * moves, and a ledger that only ever grows would end up describing where an
   * agent has been rather than where it is.
   */
  claim({ owner, worktreePath, repoPath, patterns }: ClaimRequest): ClaimOutcome {
    const kind: ClaimKind = patterns === undefined || patterns.length === 0 ? 'worktree' : 'files'

    // One worktree per repo per owner. An agent legitimately works across
    // several projects at once, so claims in different repositories are fine —
    // but two worktrees of the SAME repository means two branches of one project
    // in flight under one identity, which is a mistake worth catching rather
    // than a workflow worth supporting.
    if (repoPath !== undefined) {
      const elsewhere = this.claims.find(
        c => c.owner === owner && c.repoPath === repoPath && c.worktreePath !== worktreePath,
      )
      if (elsewhere !== undefined)
        return {
          ok: false,
          reason:
            `"${owner}" already holds a claim in ${elsewhere.worktreePath}, which is another worktree of ` +
            `the same repository. One worktree per repo per agent — release that one first.`,
          conflicts: [elsewhere],
        }
    }

    const collisions = this.inWorktree(worktreePath).flatMap(claim => {
      const collision = claim.owner === owner ? undefined : collisionWith(claim, kind, patterns ?? [])
      return collision === undefined ? [] : [{ claim, collision }]
    })
    if (collisions.length > 0)
      return {
        ok: false,
        reason: describeConflicts(collisions, worktreePath),
        conflicts: collisions.map(({ claim }) => claim),
      }

    const replaced = this.releaseIn(owner, worktreePath)
    const claim: Claim = {
      owner,
      worktreePath,
      ...(repoPath === undefined ? {} : { repoPath }),
      kind,
      patterns: [...(patterns ?? [])],
      at: this.now(),
    }
    this.claims.push(claim)
    return { ok: true, claim, replaced }
  }

  /** Drop one owner's claim in one worktree. Returns whether anything was held. */
  releaseIn(owner: string, worktreePath: string): boolean {
    return this.remove(c => c.owner === owner && c.worktreePath === worktreePath)
  }

  /**
   * Drop everything an owner holds, anywhere.
   *
   * Called when a connection closes, which is what makes a claim a LEASE HELD BY
   * PRESENCE rather than a lock: nothing has to be reaped, nothing goes stale,
   * and an agent that dies mid-task stops blocking its peers immediately.
   */
  releaseAll(owner: string): boolean {
    return this.remove(c => c.owner === owner)
  }

  private remove(predicate: (claim: Claim) => boolean): boolean {
    let removed = false
    for (let i = this.claims.length - 1; i >= 0; i--) {
      if (!predicate(this.claims[i]!)) continue
      this.claims.splice(i, 1)
      removed = true
    }
    return removed
  }
}

/** A held pattern and a wanted one that some path matches both. */
type Collision = { held: string; wanted: string } | 'worktree'

/** A whole-worktree claim owns everything, so it collides with anything else in it. */
function collisionWith(held: Claim, kind: ClaimKind, patterns: readonly string[]): Collision | undefined {
  if (held.kind === 'worktree' || kind === 'worktree') return 'worktree'
  for (const existing of held.patterns) {
    const wanted = patterns.find(pattern => patternsOverlap(existing, pattern))
    if (wanted !== undefined) return { held: existing, wanted }
  }
  return undefined
}

function describeConflicts(
  conflicts: Array<{ claim: Claim; collision: Collision }>,
  worktreePath: string,
): string {
  const parts = conflicts.map(({ claim, collision }) =>
    claim.kind === 'worktree'
      ? `"${claim.owner}" holds the whole worktree`
      : collision === 'worktree'
        ? `"${claim.owner}" holds ${claim.patterns.join(', ')}`
        : `"${claim.owner}" holds ${collision.held} (overlaps your ${collision.wanted})`,
  )
  return (
    `Refused: ${parts.join('; ')} in ${worktreePath}. Message them before editing there — a claim is ` +
    `advisory, so it marks who got there first rather than preventing the write.`
  )
}
