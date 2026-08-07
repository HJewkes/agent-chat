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
 * Exact and containment cases are decided exactly. Wildcard-against-wildcard
 * cannot be decided without enumerating the filesystem, so it falls back to
 * comparing literal prefixes, which is deliberately CONSERVATIVE: it may call an
 * overlap that no file realises, and the cost of that is a refused claim and a
 * conversation, against the cost of a missed one, which is a silently lost edit.
 */
export function patternsOverlap(a: string, b: string): boolean {
  if (a === b) return true
  // A pattern with no wildcard is a concrete path, so the other can be asked
  // directly whether it covers it.
  if (!hasWildcard(b) && matchPattern(b, a)) return true
  if (!hasWildcard(a) && matchPattern(a, b)) return true
  const [prefixA, prefixB] = [literalPrefix(a), literalPrefix(b)]
  return prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA)
}

const hasWildcard = (pattern: string): boolean => pattern.includes('*')

/** Everything up to the first wildcard, trimmed to a path boundary. */
function literalPrefix(pattern: string): string {
  const star = pattern.indexOf('*')
  const head = star === -1 ? pattern : pattern.slice(0, star)
  const cut = head.lastIndexOf('/')
  return star === -1 ? head : cut === -1 ? '' : head.slice(0, cut + 1)
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

    const conflicts = this.inWorktree(worktreePath).filter(
      held => held.owner !== owner && collides(held, kind, patterns ?? []),
    )
    if (conflicts.length > 0)
      return { ok: false, reason: describeConflicts(conflicts, worktreePath), conflicts }

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

/** A whole-worktree claim owns everything, so it collides with anything else in it. */
function collides(held: Claim, kind: ClaimKind, patterns: readonly string[]): boolean {
  if (held.kind === 'worktree' || kind === 'worktree') return true
  return held.patterns.some(existing => patterns.some(wanted => patternsOverlap(existing, wanted)))
}

function describeConflicts(conflicts: Claim[], worktreePath: string): string {
  const parts = conflicts.map(c =>
    c.kind === 'worktree'
      ? `"${c.owner}" holds the whole worktree`
      : `"${c.owner}" holds ${c.patterns.join(', ')}`,
  )
  return (
    `Refused: ${parts.join('; ')} in ${worktreePath}. Message them before editing there — a claim is ` +
    `advisory, so it marks who got there first rather than preventing the write.`
  )
}
