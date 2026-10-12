import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO = path.resolve(import.meta.dirname, '../..')
const SCRIPT = path.join(REPO, 'scripts/build-guard.mjs')
const GUARD_PREFIX = 'node scripts/build-guard.mjs && '

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-guard-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

// CI sets CI=true, so a refusal test that inherited it would pass vacuously.
const run = (extra: Record<string, string> = {}) => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  if (!('CI' in extra)) delete env.CI
  if (!('AGENT_CHAT_BUILD_IN_MAIN' in extra)) delete env.AGENT_CHAT_BUILD_IN_MAIN
  return spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8', env })
}

const asMainCheckout = () => fs.mkdirSync(path.join(dir, '.git'))

describe('build guard', () => {
  it('refuses in a main checkout and names the broker-restart window and the bypass', () => {
    asMainCheckout()

    const result = run()

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/broker-restart window/)
    expect(result.stderr).toMatch(/restart-window\.sh/)
    expect(result.stderr).toMatch(/AGENT_CHAT_BUILD_IN_MAIN=1/)
  })

  it('passes in a linked worktree whose .git is a file', () => {
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /x/.git/worktrees/w\n')

    const result = run()

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
  })

  it('passes in a staging copy with no .git, as restart-window builds', () => {
    expect(run().status).toBe(0)
  })

  it('passes in a main checkout when AGENT_CHAT_BUILD_IN_MAIN=1', () => {
    asMainCheckout()

    expect(run({ AGENT_CHAT_BUILD_IN_MAIN: '1' }).status).toBe(0)
  })

  it('still refuses when AGENT_CHAT_BUILD_IN_MAIN is set to anything but 1', () => {
    asMainCheckout()

    expect(run({ AGENT_CHAT_BUILD_IN_MAIN: '0' }).status).toBe(1)
  })

  it('passes in a CI checkout, whose .git is a directory', () => {
    asMainCheckout()

    expect(run({ CI: 'true' }).status).toBe(0)
  })

  it('runs before tsc and vite in the package build scripts', () => {
    const { scripts } = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))

    expect(scripts.build.startsWith(GUARD_PREFIX)).toBe(true)
    expect(scripts['build:dashboard'].startsWith(GUARD_PREFIX)).toBe(true)
  })
})
