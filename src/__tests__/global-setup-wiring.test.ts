import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * CC-184 guard: dropping `globalSetup` from vitest.config.ts leaves every test green
 * and every temp state dir behind. The run root is the only trace the wiring leaves.
 */
describe('vitest globalSetup temp-root wiring', () => {
  it('gives every worker a run root under the temp dir that global-setup removes', () => {
    const root = process.env.TEST_HOME_ROOT

    expect(root).toBeDefined()
    expect(path.dirname(root as string)).toBe(os.tmpdir().replace(/\/$/, ''))
    expect(fs.statSync(root as string).isDirectory()).toBe(true)
  })

  it('creates the per-file state dir inside that run root', () => {
    expect(path.dirname(process.env.AGENT_CHAT_HOME as string)).toBe(process.env.TEST_HOME_ROOT)
  })
})
