import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ObservedPresence } from './protocol.js'

const execFileAsync = promisify(execFile)

/**
 * One `git` invocation, returning null rather than throwing.
 *
 * git failures are routine control flow here — "is this a repository at all" is
 * a failing command, and every caller in this module treats a miss as an answer.
 * Injectable so tests never shell out: a unit test that runs real git is a test
 * of whatever repository it happens to be standing in.
 */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<string | null>

export const runGit: GitRunner = async (args, cwd) => {
  try {
    const { stdout } = await execFileAsync('git', [...args], { cwd, encoding: 'utf8' })
    return stdout.trim()
  } catch {
    return null
  }
}

/**
 * The true repository root, resolved through worktrees.
 *
 * `--git-common-dir` rather than `--show-toplevel`: when this runs from inside a
 * worktree, the toplevel is that worktree, and allocating from it would nest
 * worktrees inside worktrees. Non-obvious, and it is the whole reason this
 * helper exists rather than a one-liner at each call site.
 *
 * Lives here rather than in `agents/isolation/worktree.ts` (its original home)
 * because CC-11 needs the same resolution from the MCP subprocess, and importing
 * it from there would drag the whole isolation strategy graph into `server/`.
 */
export async function findGitRoot(cwd: string, git: GitRunner = runGit): Promise<string | null> {
  const commonDir = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)
  return commonDir === null ? null : path.dirname(commonDir)
}

/**
 * What can be OBSERVED about where a session is running, as opposed to what it
 * says about itself. Read from the session's own process, at registration.
 *
 * Returns undefined outside a git repository — the honest answer, and it keeps
 * `observed` absent rather than present-but-empty, which a renderer would
 * otherwise have to special-case.
 *
 * `--show-toplevel` here and `--git-common-dir` above answer different
 * questions, and both are wanted: the toplevel is the checkout this session's
 * files actually live in (what a peer needs to know it shares), while the common
 * dir identifies the repository behind it. When they disagree, this is a linked
 * worktree — which is precisely how two sessions on one repo can be doing
 * genuinely independent work, and the case a shared-cwd check alone cannot see.
 */
export async function observedPresence(
  cwd: string,
  git: GitRunner = runGit,
): Promise<ObservedPresence | undefined> {
  const [branch, toplevel, commonDir, gitDir] = await Promise.all([
    git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    git(['rev-parse', '--show-toplevel'], cwd),
    git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd),
    git(['rev-parse', '--path-format=absolute', '--git-dir'], cwd),
  ])
  if (toplevel === null && commonDir === null) return undefined

  const observed: ObservedPresence = {
    // 'HEAD' means detached, which is not a branch name. Reporting it would put
    // the literal string "HEAD" in every peer's chat_list and read as one.
    ...(branch !== null && branch !== '' && branch !== 'HEAD' ? { gitBranch: branch } : {}),
    ...(toplevel === null || toplevel === '' ? {} : { worktreePath: toplevel }),
    ...(commonDir === null || gitDir === null
      ? {}
      : { isLinkedWorktree: path.resolve(commonDir) !== path.resolve(gitDir) }),
  }
  return Object.keys(observed).length === 0 ? undefined : observed
}

/**
 * The `observed` half of a registration, spread-ready, so both register paths
 * (the model calling chat_register and a spawned agent registering from its
 * environment) derive it the same way rather than each rolling their own.
 *
 * Never throws: git is absent on some machines and a registration that failed
 * because a subprocess did not exist would be a far worse bug than an
 * unannotated session.
 */
export async function observedRegistration(
  cwd: string = process.cwd(),
): Promise<{ observed?: ObservedPresence }> {
  const observed = await observedPresence(cwd)
  return observed === undefined ? {} : { observed }
}
