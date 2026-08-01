import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Where a spawn is allowed to put a process — §11.2's `cwd` gate, as a pure
 * function of the filesystem and the session roster.
 *
 * ## What changed, and what did not (CC-62)
 *
 * The first version of this rule was "at or under the cwd of some currently-
 * registered session". That is a containment rule with an accidental
 * precondition: it only lets a peer spawn somewhere ANOTHER session already
 * happens to be sitting. `isolation: worktree` needs a real git repo at `cwd`,
 * and the coordinator's own directory usually is not one — so worktree spawns
 * into a repo nobody had open were refused for a reason unrelated to safety,
 * and the workaround was to give up isolation and tell the agent to `cd` in its
 * brief. A sandbox whose documented workaround is "leave the sandbox" is not
 * buying anything.
 *
 * The property worth keeping is the one the spec actually argues for: a peer
 * cannot spawn in `~/.ssh`. That is a statement about SENSITIVE paths, not about
 * occupied ones. So the rule is now:
 *
 * 1. exists, and is a directory (unchanged, and applies to the human too);
 * 2. never inside a credential directory — checked for peers even when a
 *    session is registered there, which is strictly tighter than before;
 * 3. otherwise allowed if it is at or under a registered session's cwd (the old
 *    rule, kept: work already happening is self-evidently a work directory), OR
 *    strictly under the user's home or the system temp dir.
 *
 * Rule 3's second half is the new capability. It is anchored rather than
 * unlimited on purpose: `/etc`, `/usr`, another user's home and the filesystem
 * root stay unreachable for a peer, and so does `$HOME` itself — "spawn an agent
 * with the run of your entire home directory" is the request this should still
 * refuse. A repo outside those roots (`/Volumes/work/thing`) is reachable only
 * once a session is registered in it, or by the human, who is exempt.
 */

/**
 * Directory names that make a path off-limits wherever they appear in it.
 *
 * Names, not full paths: `~/.ssh` and `~/work/backup/.ssh` hold the same key
 * material, and a rule that only knew the first would be a rule about typing.
 * The list is credentials and agent state — the things a read-only profile with
 * a legitimate-looking `cwd` would otherwise be able to sit on top of and read.
 */
export const SENSITIVE_DIRS: readonly string[] = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.gcloud',
  '.kube',
  '.docker',
  '.config',
  '.password-store',
  '.claude',
  '.agent-chat',
  'Keychains',
]

export interface CwdPolicy {
  /** Every registered session's cwd. Unresolvable entries are skipped, not fatal. */
  sessionRoots: readonly string[]
  /** Overridable so a test can point the workspace roots somewhere disposable. */
  homeDir?: string
  tmpDir?: string
}

/** realpath, or undefined when the path cannot be resolved at all. */
const realOf = (dir: string): string | undefined => {
  try {
    return fs.realpathSync(dir)
  } catch {
    return undefined
  }
}

const isAtOrUnder = (real: string, root: string): boolean => real === root || real.startsWith(root + path.sep)

const isStrictlyUnder = (real: string, root: string): boolean => real.startsWith(root + path.sep)

/**
 * Resolved through realpath before anything is compared, so `..` and a symlink
 * pointing out of the tree are both caught rather than passing a string test.
 * Returns the refusal reason, or undefined when the path is allowed.
 */
export function checkSpawnCwd(cwd: string, policy: CwdPolicy): string | undefined {
  let real: string
  try {
    if (!fs.statSync(cwd).isDirectory()) return `cwd is not a directory: ${cwd}`
    real = fs.realpathSync(cwd)
  } catch {
    return `cwd does not exist: ${cwd}`
  }

  const segments = real.split(path.sep)
  const sensitive = SENSITIVE_DIRS.find(name => segments.includes(name))
  if (sensitive !== undefined) return `cwd is inside a protected directory ("${sensitive}"): ${cwd}`

  const inSession = policy.sessionRoots.some(root => {
    const resolved = realOf(root)
    return resolved !== undefined && isAtOrUnder(real, resolved)
  })
  if (inSession) return undefined

  const workspaceRoots = [policy.homeDir ?? os.homedir(), policy.tmpDir ?? os.tmpdir()]
    .map(realOf)
    .filter((root): root is string => root !== undefined)
  if (workspaceRoots.some(root => isStrictlyUnder(real, root))) return undefined

  return (
    `cwd must be under your home directory or a directory some session is working in: ${cwd} ` +
    '(the home directory itself, system paths and credential directories are not spawnable)'
  )
}
