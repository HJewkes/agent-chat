/**
 * CC-177: an adopted worktree is where the work runs, so it beats the spawner's cwd, which may not
 * be a repo at all. An explicit cwd still wins, even when it lies outside the worktree.
 */
export function resolveSpawnCwd(
  msg: { cwd?: string; worktree?: string },
  spawnerCwd: string | undefined,
): string | undefined {
  return msg.cwd ?? msg.worktree ?? spawnerCwd
}
