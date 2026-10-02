import { configDefaults, defineConfig } from 'vitest/config'

/**
 * Files that need a real process of their own, each with the reason. Everything else runs on
 * worker threads, which die with the parent vitest; forks outlive it with PPID 1 (CC-429).
 */
const FORKS_FILES = [
  // Sets process.env.TZ, which a worker thread keeps in its own env copy and never applies.
  'src/__tests__/seat-journal.test.ts',
  // Sets process.env.TZ, which a worker thread keeps in its own env copy and never applies.
  'src/__tests__/seat-dispatches-verb.test.ts',
  // The next five point HOME at a temp dir for the in-process broker, but os.homedir() in a
  // worker thread still returns the developer's real home.
  'src/__tests__/spawn-account.test.ts',
  'src/__tests__/spawn-default-account.test.ts',
  'src/__tests__/resume-role-gate.test.ts',
  'src/__tests__/surface-role-gate.test.ts',
  'src/__tests__/report-batch.test.ts',
  // The next three exec scripts they just wrote. On Linux a sibling worker's fork can inherit the
  // write fd, and the exec fails with ETXTBSY until that child execs (CC-462).
  'src/__tests__/gh-shim.test.ts',
  'src/__tests__/leak-git-shim.test.ts',
  'src/__tests__/leak-git-shim-stash.test.ts',
]

const MAX_WORKERS = 4

// Shared by both projects without `extends`, which would also rerun globalSetup once per project.
const perFile = {
  // Runs before every test file, so no spawn can inherit the developer's own
  // session identity. See the file for which variables and why.
  setupFiles: ['src/__tests__/setup-env.ts'],
  testTimeout: 20000,
  hookTimeout: 30000,
}

export default defineConfig({
  test: {
    // Owns the temp state dirs setup-env.ts creates, and removes them after the run.
    globalSetup: ['src/__tests__/global-setup.ts'],
    maxWorkers: MAX_WORKERS,
    projects: [
      {
        test: {
          ...perFile,
          name: 'threads',
          pool: 'threads',
          maxWorkers: MAX_WORKERS,
          include: ['src/**/__tests__/**/*.test.ts'],
          exclude: [...configDefaults.exclude, ...FORKS_FILES],
          sequence: { groupOrder: 1 },
        },
      },
      {
        // Runs as its own group before the threads, so the two pools never stack past the cap.
        test: {
          ...perFile,
          name: 'forks',
          pool: 'forks',
          maxWorkers: 2,
          include: FORKS_FILES,
          sequence: { groupOrder: 0 },
        },
      },
    ],
  },
})
