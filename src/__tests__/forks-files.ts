/**
 * Files that exec a script they just wrote, directly or through a `helpers/` module. On Linux a sibling worker's fork can inherit the
 * write fd, and the exec fails with ETXTBSY until that child execs (CC-462, CC-477).
 */
export const EXEC_SCRIPT_FILES = [
  'src/__tests__/gh-shim.test.ts',
  'src/__tests__/gh-shim-call-log.test.ts',
  'src/__tests__/gh-shim-rate-limit.test.ts',
  'src/__tests__/gh-shim-gateway.test.ts',
  'src/__tests__/gh-shim-fallback.test.ts',
  'src/__tests__/gh-write-ticket.test.ts',
  'src/__tests__/gh-shim-write-gate.test.ts',
  'src/__tests__/leak-git-shim.test.ts',
  'src/__tests__/leak-git-shim-stash.test.ts',
  'src/__tests__/leak-git-shim-locale.test.ts',
  'src/__tests__/leak-git-shim-alias-source.test.ts',
  'src/__tests__/leak-git-shim-allowlist.test.ts',
  'src/__tests__/leak-git-mirror.test.ts',
  'src/__tests__/leak-git-shim-chain.test.ts',
  'src/__tests__/leak-shim-skip-rows.test.ts',
  'src/__tests__/leak-shell-args.test.ts',
  'src/__tests__/leak-git-shim-protocol.test.ts',
  'src/__tests__/leak-git-shim-protocol-config.test.ts',
  'src/__tests__/leak-git-config-differential.test.ts',
  'src/__tests__/gh-write.test.ts',
  'src/__tests__/gh-write-scan.test.ts',
  'src/__tests__/human-wait.test.ts',
  'src/__tests__/isolation.test.ts',
  'src/__tests__/tmux-surface.test.ts',
  'src/__tests__/launch-plan.test.ts',
  'src/__tests__/leak-pre-push.test.ts',
  'src/__tests__/leak-pre-push-policy.test.ts',
  'src/__tests__/profile-push-policy.test.ts',
  'src/__tests__/leak-git-config-routes.test.ts',
  'src/__tests__/leak-pretool-shells.test.ts',
  'src/__tests__/leak-pretool-heredoc.test.ts',
  'src/__tests__/leak-pretool-piped-shell.test.ts',
  'src/__tests__/shell-words-dup-subscript.test.ts',
  'src/__tests__/leak-pretool-stdin-sources.test.ts',
  'src/__tests__/leak-pretool-shell-command-word.test.ts',
  'src/__tests__/leak-pretool-hidden-sub.test.ts',
  'src/__tests__/posix-shell-shebang.test.ts',
  'src/__tests__/spawn-attach-live.test.ts',
  'src/__tests__/burndown-watchdog-unusable.test.ts',
  'src/__tests__/burndown-daily-retire.test.ts',
  'src/__tests__/worktree-setup.test.ts',
  'src/__tests__/worktree-setup-source.test.ts',
  'src/__tests__/worktree-git-result.test.ts',
  'src/__tests__/worktree-release-fail-closed.test.ts',
  'src/__tests__/restart-window.test.ts',
  'src/__tests__/restart-window-guard.test.ts',
  'src/__tests__/live-skill-write.test.ts',
  'src/__tests__/opt-out-kick.test.ts',
  'src/__tests__/leak-pretool-backtick.test.ts',
  'src/__tests__/leak-pretool-brace.test.ts',
  'src/__tests__/leak-pretool-locale-quote.test.ts',
  'src/__tests__/leak-pretool-push-expansion.test.ts',
  'src/__tests__/leak-pretool-job-wrappers.test.ts',
  'src/__tests__/leak-pretool-exec-wrappers.test.ts',
  'src/__tests__/leak-pretool-busybox.test.ts',
  'src/__tests__/git-sandbox-rows.test.ts',
  'src/__tests__/leak-include-fifo.test.ts',
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
  // The next seven point HOME at a temp dir for the in-process broker, but os.homedir() in a
  // worker thread still returns the developer's real home.
  'src/__tests__/spawn-account.test.ts',
  'src/__tests__/spawn-account-request.test.ts',
  'src/__tests__/spawn-home-cwd.test.ts',
  'src/__tests__/spawn-default-account.test.ts',
  'src/__tests__/resume-role-gate.test.ts',
  'src/__tests__/surface-role-gate.test.ts',
  'src/__tests__/report-batch.test.ts',
  // git execs the pre-push hook writeGitHooks just wrote; the write sits in production code, so the detector misses it.
  'src/__tests__/leak-scan-path.test.ts',
  // Runs ss over the whole process table; its 2 s cap is outrun under the threads group's load (CC-1164).
  'src/__tests__/peer-locality-socket.test.ts',
  ...EXEC_SCRIPT_FILES,
]
