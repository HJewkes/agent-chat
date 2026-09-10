import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    // Runs before every test file, so no spawn can inherit the developer's own
    // session identity. See the file for which variables and why.
    setupFiles: ['src/__tests__/setup-env.ts'],
    testTimeout: 20000,
    hookTimeout: 30000,
  },
})
