import fs from 'node:fs'
import path from 'node:path'
import type { LaunchPlan } from '@titan-design/agent-surface'
import { AGENT_NAME_PATTERN } from '../launch-identity.js'
import { realTmpFs, type TmpFs } from './agent-tmpdir.js'
import { gitMarkerAt } from '../git-marker.js'
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
 * CC-1469: deliberately looser than `isReviewerSpawn`, because a tree name feeds only pool and
 * state counting. A whole `review` token counts, so an adversarial `seat-1-adv-review` is a
 * reviewer tree and `preview` is not; the spawn side leaves `review` out, since a reviewer spawn
 * is forced into a worktree and parked at report.
 */
const REVIEWER_TREE_TOKENS = new Set(['reviewer', 'review'])

/**
 * CC-1040: a tree on disk carries only its directory name, so the reviewer worktree pool is
 * decided from the agent name alone, the same way when allocating and when counting.
 */
export function isReviewerTreeName(name: string): boolean {
  const tokens = tokensOf(name)
  return tokens[0] === 'rv' || tokens.some(t => REVIEWER_TREE_TOKENS.has(t))
}

/**
 * The primary checkout `cwd` sits in, when it does: the nearest ancestor holding `.git`, and
 * that `.git` is a directory. A linked worktree's `.git` is a file, and a directory with no
 * repository above it (a review dir under the user's data home) has none.
 */
export function primaryCheckoutOf(cwd: string): string | undefined {
  let dir = canonicalPath(cwd)
  for (;;) {
    const marker = gitMarkerAt(dir)
    if (marker !== undefined) return marker === 'dir' ? dir : undefined
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * CC-311: a reviewer kills mutants in its own tree under `$TMPDIR/<name>`. Outside its working
 * directories Claude Code resets a `cd` and asks about absolute writes, and a headless reviewer
 * has nobody to answer, so the launcher adds the tree as a working directory.
 */
export type ScratchFs = Pick<TmpFs, 'lstat' | 'mkdir' | 'chmod'> & { realpath(path: string): string }

export const realScratchFs: ScratchFs = { ...realTmpFs, realpath: p => fs.realpathSync(p) }

const SCRATCH_MODE = 0o700
const VALID_NAME = new RegExp(`^${AGENT_NAME_PATTERN}$`, 'i')

/** `<realpath TMPDIR>/<name>`, created 0700; undefined for a non-reviewer, a symlink or a non-directory. */
export function reviewerScratchDir(
  env: Record<string, string | undefined>,
  scratchFs: ScratchFs = realScratchFs,
): string | undefined {
  const { TMPDIR: tmp, AGENT_CHAT_PROFILE: profile = '', AGENT_CHAT_NAME: name } = env
  if (tmp === undefined || tmp === '' || name === undefined || !VALID_NAME.test(name)) return undefined
  if (!isReviewerSpawn(profile, name)) return undefined
  try {
    const dir = path.join(scratchFs.realpath(tmp), name)
    const stat = scratchFs.lstat(dir)
    if (stat === undefined) scratchFs.mkdir(dir, SCRATCH_MODE)
    else if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined
    else scratchFs.chmod(dir, SCRATCH_MODE)
    return dir
  } catch {
    return undefined
  }
}

/** First in argv, so neither a variadic flag nor the `--` before the brief can swallow it. */
export function withScratchAddDir(plan: LaunchPlan, dir: string | undefined): LaunchPlan {
  return dir === undefined ? plan : { ...plan, args: ['--add-dir', dir, ...plan.args] }
}
