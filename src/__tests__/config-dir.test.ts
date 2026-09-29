import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  accountName,
  checkConfigDir,
  childConfigDir,
  profileDir,
  resolveConfigDir,
} from '../agents/config-dir.js'

/**
 * CC-100. The bug was not that the precedence was wrong — there was no
 * precedence. Every spawned agent ran on whatever account the broker daemon
 * happened to inherit, which is why four agents spawned from a `workout` session
 * died on the wrong account's spend limit.
 *
 * Every case here pins one step of the rule the human settled, and the ordering
 * assertions are the ones that matter: a step that silently outranks the one above
 * it reproduces the original failure with a different cause.
 */

const HOME = '/Users/test'

/** The dirs that exist in these tests. Injected, so nothing here touches real state. */
const exists =
  (...dirs: string[]) =>
  (dir: string) =>
    dirs.includes(dir)

const req = (over: Parameters<typeof resolveConfigDir>[0] = {}) => ({
  home: HOME,
  env: {} as NodeJS.ProcessEnv,
  isDirectory: exists(),
  ...over,
})

const dirOf = (over: Parameters<typeof resolveConfigDir>[0] = {}) => {
  const resolution = resolveConfigDir(req(over))
  if ('error' in resolution) throw new Error(`expected a resolution, got: ${resolution.error}`)
  return resolution
}

describe('which account a spawned agent runs on', () => {
  it('takes an explicit config_dir over everything else', () => {
    const explicit = `${HOME}/.claude-profiles/billing`
    const resolved = dirOf({
      explicit,
      spawner: `${HOME}/.claude-profiles/workout`,
      profile: 'agents',
      env: { CLAUDE_CONFIG_DIR: `${HOME}/.claude-profiles/broker` },
      isDirectory: exists(explicit, `${HOME}/.claude-profiles/agents`),
    })

    expect(resolved).toEqual({ dir: explicit, source: 'explicit' })
  })

  /**
   * The step CC-100 existed to add, and the one the mutation test drops: without
   * it a spawn from a session on a dedicated account lands on the broker's.
   */
  it('takes the spawner’s own dir over the initiative profile and the broker', () => {
    const spawner = `${HOME}/.claude-profiles/workout`
    const resolved = dirOf({
      spawner,
      profile: 'agents',
      env: { CLAUDE_CONFIG_DIR: `${HOME}/.claude-profiles/broker` },
      isDirectory: exists(`${HOME}/.claude-profiles/agents`),
    })

    expect(resolved).toEqual({ dir: spawner, source: 'spawner' })
  })

  it('falls to the briefing initiative’s profile when nobody named an account', () => {
    const profileAccount = `${HOME}/.claude-profiles/agents`
    const resolved = dirOf({
      profile: 'agents',
      env: { CLAUDE_CONFIG_DIR: `${HOME}/.claude-profiles/broker` },
      isDirectory: exists(profileAccount),
    })

    expect(resolved).toEqual({ dir: profileAccount, source: 'profile' })
  })

  it('falls to the broker’s own env, then to ~/.claude', () => {
    const broker = `${HOME}/.claude-profiles/broker`
    expect(dirOf({ env: { CLAUDE_CONFIG_DIR: broker } })).toEqual({ dir: broker, source: 'broker' })
    expect(dirOf()).toEqual({ dir: path.join(HOME, '.claude'), source: 'broker' })
  })

  /**
   * Warn and carry on, matching active-work's own launcher: the work is still
   * doable on the active account, and stranding an initiative behind a config
   * problem is worse. What must not happen is silence — that is CC-100's whole
   * complaint.
   */
  it('warns and falls back when the initiative’s profile dir does not exist', () => {
    const resolved = dirOf({ profile: 'ghost', env: { CLAUDE_CONFIG_DIR: `${HOME}/.claude` } })

    expect(resolved.dir).toBe(`${HOME}/.claude`)
    expect(resolved.source).toBe('broker')
    expect(resolved.warning).toContain(`${HOME}/.claude-profiles/ghost`)
    expect(resolved.warning).toContain('does not exist')
  })

  it('honours CLAUDE_PROFILE_ROOT the way active-work resolves it', () => {
    const env = { CLAUDE_PROFILE_ROOT: '/opt/accounts' } as NodeJS.ProcessEnv
    expect(profileDir('agents', env, HOME)).toBe('/opt/accounts/agents')
    // Relative is ignored rather than resolved against an arbitrary cwd, which is
    // the rule active-work's `profileRoot` applies.
    expect(profileDir('agents', { CLAUDE_PROFILE_ROOT: 'accounts' }, HOME)).toBe(
      `${HOME}/.claude-profiles/agents`,
    )
  })
})

/**
 * An explicit dir is the one step that REFUSES. Every other step has a
 * defensible fallback because nobody asked for anything in particular; this one
 * is a caller naming an account to bill, and running elsewhere instead is the
 * exact failure wearing the shape of a success.
 */
describe('an explicit config_dir that cannot be used', () => {
  it('refuses a relative path', () => {
    const resolution = resolveConfigDir(req({ explicit: '.claude-profiles/agents' }))
    expect(resolution).toEqual({ error: expect.stringContaining('absolute path') })
  })

  it('refuses a path outside the user’s home', () => {
    const resolution = resolveConfigDir(req({ explicit: '/etc/claude', isDirectory: exists('/etc/claude') }))
    expect(resolution).toEqual({ error: expect.stringContaining('under your home directory') })
  })

  it('refuses a dir that does not exist, rather than creating or ignoring it', () => {
    const resolution = resolveConfigDir(req({ explicit: `${HOME}/.claude-profiles/nope` }))
    expect(resolution).toEqual({ error: expect.stringContaining('not an existing directory') })
  })

  it('refuses the home directory itself, which is not a config dir', () => {
    expect(checkConfigDir(HOME, { home: HOME, isDirectory: exists(HOME) })).toContain(
      'under your home directory',
    )
  })

  it('does not let .. climb out of home', () => {
    const escape = `${HOME}/../elsewhere/.claude`
    expect(checkConfigDir(escape, { home: HOME, isDirectory: () => true })).toContain(
      'under your home directory',
    )
  })
})

describe('a spawner that is a known Claude session with no CLAUDE_CONFIG_DIR', () => {
  it('runs on the default ~/.claude over the initiative profile and the broker', () => {
    const resolved = dirOf({
      spawnerIsSession: true,
      profile: 'agents',
      env: { CLAUDE_CONFIG_DIR: `${HOME}/.claude-profiles/broker` },
      isDirectory: exists(`${HOME}/.claude-profiles/agents`),
    })

    expect(resolved).toEqual({ dir: `${HOME}/.claude`, source: 'spawner', unset: true })
  })

  it('names the explicit config_dir without the unset marker, even when it is ~/.claude (CC-200)', () => {
    const explicit = `${HOME}/.claude`

    const resolved = dirOf({ explicit, spawnerIsSession: true, isDirectory: exists(explicit) })

    expect(resolved).toEqual({ dir: explicit, source: 'explicit' })
  })

  it('still yields to the spawner’s own dir when one was observed', () => {
    const spawner = `${HOME}/.claude-profiles/workout`

    expect(dirOf({ spawner, spawnerIsSession: true })).toEqual({ dir: spawner, source: 'spawner' })
  })
})

describe('the CLAUDE_CONFIG_DIR a child process sees', () => {
  it('is nothing at all for an unset account, and the dir otherwise', () => {
    expect(childConfigDir({ dir: `${HOME}/.claude`, unset: true })).toBeUndefined()
    expect(childConfigDir({ dir: `${HOME}/.claude` })).toBe(`${HOME}/.claude`)
  })
})

describe('the name a human calls an account', () => {
  it('is the last segment of the dir', () => {
    expect(accountName(`${HOME}/.claude-profiles/workout`, HOME)).toBe('workout')
  })

  it('is "default" for ~/.claude', () => {
    expect(accountName(`${HOME}/.claude`, HOME)).toBe('default')
  })
})
