import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { gitChildEnv, runGit, type GitRunner } from '../../git.js'

/**
 * CC-1581: a Shepherd fixer (`-s1`) pushes its commits to its parent's branch, so its own branch name
 * never reaches origin. A local `origin/*` tracking ref that contains the commit names the candidates;
 * it may be stale, so only a fresh `ls-remote` head that still contains the commit counts as proof.
 */

const execFileAsync = promisify(execFile)

const LS_REMOTE_TIMEOUT_MS = 15_000

/** A commit an old base is in sits in every branch; the branch a fixer pushed to is among the first. */
const MAX_CANDIDATES = 5

/** Origin branches whose local tracking ref contains `ref`; a candidate only, never proof on its own. */
export async function trackedOriginBranchesContaining(
  dir: string,
  ref: string,
  git: GitRunner = runGit,
): Promise<string[]> {
  const out = await git(
    ['for-each-ref', '--contains', ref, '--format=%(refname:lstrip=3)', 'refs/remotes/origin/'],
    dir,
  )
  if (out === null) return []
  return out
    .split('\n')
    .filter(branch => branch !== '' && branch !== 'HEAD')
    .slice(0, MAX_CANDIDATES)
}

async function liveOriginHeads(dir: string, branches: readonly string[]): Promise<Map<string, string>> {
  const patterns = branches.map(branch => `refs/heads/${branch}`)
  const heads = new Map<string, string>()
  try {
    const { stdout } = await execFileAsync('git', ['ls-remote', '--heads', 'origin', ...patterns], {
      cwd: dir,
      env: gitChildEnv(),
      encoding: 'utf8',
      timeout: LS_REMOTE_TIMEOUT_MS,
    })
    for (const line of stdout.split('\n')) {
      const [sha, name] = line.split('\t')
      if (sha && name?.startsWith('refs/heads/')) heads.set(name.slice('refs/heads/'.length), sha)
    }
  } catch {
    return new Map()
  }
  return heads
}

/** The origin branch whose current head contains `ref`, or undefined when none does or origin cannot be read. */
export async function originBranchHolding(
  dir: string,
  ref: string,
  git: GitRunner = runGit,
): Promise<string | undefined> {
  const candidates = await trackedOriginBranchesContaining(dir, ref, git)
  if (candidates.length === 0) return undefined
  for (const [branch, sha] of await liveOriginHeads(dir, candidates)) {
    if ((await git(['merge-base', '--is-ancestor', ref, sha], dir)) !== null) return branch
  }
  return undefined
}
