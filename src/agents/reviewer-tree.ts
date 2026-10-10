import fs from 'node:fs'
import path from 'node:path'
import { canonicalPath } from './spawn-cwd.js'

/**
 * CC-916: a reviewer reads and runs checks, and its git writes (a checkout of the PR head, a
 * stash, a pull) must never land in a repo's primary checkout, where they block deploys.
 *
 * Reviewer-ness is read from names rather than a profile field, because Shepherd's reviewer
 * profile is operator-configured (`rv-readonly`) and a profile written before this existed
 * has no flag to carry. Tokens are matched whole so `reviewer-lite` counts and `previewer` does not.
 */
const REVIEWER_TOKENS = new Set(['reviewer', 'rv'])

const tokensOf = (name: string): string[] => name.toLowerCase().split(/[^a-z0-9]+/)

export function isReviewerSpawn(profileName: string, agentName: string): boolean {
  return tokensOf(profileName).some(t => REVIEWER_TOKENS.has(t)) || tokensOf(agentName)[0] === 'rv'
}

/**
 * The primary checkout `cwd` sits in, when it does: the nearest ancestor holding `.git`, and
 * that `.git` is a directory. A linked worktree's `.git` is a file, and a directory with no
 * repository above it (a review dir under the user's data home) has none.
 */
export function primaryCheckoutOf(cwd: string): string | undefined {
  let dir = canonicalPath(cwd)
  for (;;) {
    try {
      const stat = fs.statSync(path.join(dir, '.git'))
      return stat.isDirectory() ? dir : undefined
    } catch {
      // No .git here; keep climbing.
    }
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}
