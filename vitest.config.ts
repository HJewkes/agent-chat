import { defineConfig } from 'vitest/config'

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
  },
})
