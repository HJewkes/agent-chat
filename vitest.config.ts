import { configDefaults, defineConfig } from 'vitest/config'

import { FORKS_FILES } from './src/__tests__/forks-files.js'

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
