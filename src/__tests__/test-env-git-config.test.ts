import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { gitHooksEnv } from '../leak-guard/hooks-dir.js'
import { withoutInjectedHooksPath } from './helpers/git-config-env.js'

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chat-git-config-env-'))

afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }))

const hooksPathSeenBy = (env: NodeJS.ProcessEnv): string => {
  spawnSync('git', ['init', '-q', SCRATCH], { env })
  return spawnSync('git', ['config', 'core.hooksPath'], { cwd: SCRATCH, env, encoding: 'utf8' }).stdout.trim()
}

describe('the test env drops the leak guard hooks path (CC-335)', () => {
  it('leaves no hooks-path pair in the test process env', () => {
    const keys = Object.entries(process.env)
      .filter(([name]) => name.startsWith('GIT_CONFIG_KEY_'))
      .map(([, key]) => key?.toLowerCase())

    expect(keys).not.toContain('core.hookspath')
    expect(withoutInjectedHooksPath(process.env)).toEqual(process.env)
  })

  it('still lets a launch env point git at the guard dir, so a real push is scanned', () => {
    const env = gitHooksEnv('/state/git-hooks')

    expect(env).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/state/git-hooks',
    })
    expect(hooksPathSeenBy({ ...process.env, ...env })).toBe('/state/git-hooks')
  })

  it('removes the guard pair and every GIT_CONFIG_* variable when nothing else was set', () => {
    const out = withoutInjectedHooksPath({ PATH: '/bin', ...gitHooksEnv('/state/git-hooks') })

    expect(out).toEqual({ PATH: '/bin' })
  })

  it('keeps the other pairs, renumbered from zero', () => {
    const out = withoutInjectedHooksPath({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'Probe',
      GIT_CONFIG_KEY_1: 'core.hooksPath',
      GIT_CONFIG_VALUE_1: '/state/git-hooks',
      GIT_CONFIG_KEY_2: 'init.defaultBranch',
      GIT_CONFIG_VALUE_2: 'main',
    })

    expect(out).toEqual({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'Probe',
      GIT_CONFIG_KEY_1: 'init.defaultBranch',
      GIT_CONFIG_VALUE_1: 'main',
    })
  })

  it('matches the key the way git does, case-insensitively', () => {
    const out = withoutInjectedHooksPath({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'CORE.HOOKSPATH',
      GIT_CONFIG_VALUE_0: '/state/git-hooks',
    })

    expect(out).toEqual({})
  })

  it('leaves an env without a hooks-path pair, or with a malformed count, unchanged', () => {
    const plain = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Probe' }
    const malformed = { GIT_CONFIG_COUNT: 'x', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/h' }

    expect(withoutInjectedHooksPath(plain)).toEqual(plain)
    expect(withoutInjectedHooksPath(malformed)).toEqual(malformed)
  })
})
