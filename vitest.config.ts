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
]

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    // Runs before every test file, so no spawn can inherit the developer's own
    // session identity. See the file for which variables and why.
    // Owns the temp state dirs setup-env.ts creates, and removes them after the run.
    globalSetup: ['src/__tests__/global-setup.ts'],
    setupFiles: ['src/__tests__/setup-env.ts'],
    testTimeout: 20000,
    hookTimeout: 30000,
    maxWorkers: 4,
    projects: [
      {
        extends: true,
        test: {
          name: 'threads',
          pool: 'threads',
          exclude: [...configDefaults.exclude, ...FORKS_FILES],
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        // Runs as its own group before the threads, so the two pools never stack past the cap.
        test: {
          name: 'forks',
          pool: 'forks',
          include: FORKS_FILES,
          maxWorkers: 2,
          sequence: { groupOrder: 0 },
        },
      },
    ],
  },
})
