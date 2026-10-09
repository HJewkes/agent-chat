import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * CC-184 guard: dropping `globalSetup` from vitest.config.ts leaves every test green
 * and every temp state dir behind. The run root is the only trace the wiring leaves.
 */
describe('vitest globalSetup temp-root wiring', () => {
  it("makes the run root every worker's temp dir, so a mkdtemp under it is removed with the run (CC-900)", () => {
    const root = process.env.TEST_HOME_ROOT

    expect(root).toBeDefined()
    expect(fs.statSync(root as string).isDirectory()).toBe(true)
    expect(os.tmpdir()).toBe(root)
    expect(path.dirname(process.env.npm_config_store_dir as string)).toBe(root)
  })

  it('creates the per-file state dir inside that run root', () => {
    expect(path.dirname(process.env.AGENT_CHAT_HOME as string)).toBe(process.env.TEST_HOME_ROOT)
  })
})
