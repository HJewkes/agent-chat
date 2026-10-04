/**
 * Files that exec a script they just wrote. On Linux a sibling worker's fork can inherit the
 * write fd, and the exec fails with ETXTBSY until that child execs (CC-462, CC-477).
 */
export const EXEC_SCRIPT_FILES = [
  'src/__tests__/gh-shim.test.ts',
  'src/__tests__/leak-git-shim.test.ts',
  'src/__tests__/leak-git-shim-stash.test.ts',
  'src/__tests__/gh-write.test.ts',
  'src/__tests__/gh-write-scan.test.ts',
  'src/__tests__/human-wait.test.ts',
  'src/__tests__/isolation.test.ts',
  'src/__tests__/launch-plan.test.ts',
  'src/__tests__/leak-pre-push.test.ts',
  'src/__tests__/leak-pretool-shells.test.ts',
  'src/__tests__/spawn-attach-live.test.ts',
  'src/__tests__/worktree-setup.test.ts',
  'src/__tests__/restart-window.test.ts',
  'src/__tests__/restart-window-guard.test.ts',
]

/**
 * Files that need a real process of their own, each with the reason. Everything else runs on
 * worker threads, which die with the parent vitest; forks outlive it with PPID 1 (CC-429).
 */
export const FORKS_FILES = [
  // Sets process.env.TZ, which a worker thread keeps in its own env copy and never applies.
  'src/__tests__/seat-journal.test.ts',
  // Sets process.env.TZ, which a worker thread keeps in its own env copy and never applies.
  'src/__tests__/seat-dispatches-verb.test.ts',
  // The next six point HOME at a temp dir for the in-process broker, but os.homedir() in a
  // worker thread still returns the developer's real home.
  'src/__tests__/spawn-account.test.ts',
  'src/__tests__/spawn-home-cwd.test.ts',
  'src/__tests__/spawn-default-account.test.ts',
  'src/__tests__/resume-role-gate.test.ts',
  'src/__tests__/surface-role-gate.test.ts',
  'src/__tests__/report-batch.test.ts',
  ...EXEC_SCRIPT_FILES,
]
