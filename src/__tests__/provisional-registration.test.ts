import { describe, expect, it } from 'vitest'
import { activeWorkSlug, disambiguated, provisionalName } from '../server/provisional.js'
import { Registry } from '../broker/registry.js'
import type { Conn } from '../broker/core.js'

/**
 * CC-82. `chat_register` is a tool the MODEL calls, so a session was addressable
 * only if its model complied with an instruction. Measured 2026-08-11: four live
 * sessions on one machine, every one with a healthy MCP subprocess holding
 * broker sockets, none of them in `chat_list` — including the session doing the
 * diagnosing. These cover the naming, and the mark that keeps a derived name
 * from reading as a declared one.
 */

const conn = (): Conn => ({}) as unknown as Conn

describe('deriving a name for a session that never chose one', () => {
  /**
   * The best source, and the one that would have covered three of the four
   * measured cases: a session bootstrapped on an initiative sits in that
   * initiative's directory from the moment it starts.
   */
  it('takes the initiative slug from an active-work directory', () => {
    const cwd = '/Users/x/Library/Application Support/active-work/relay'
    expect(provisionalName({ cwd })).toBe('relay')
  })

  it('names the three sessions that were actually invisible', () => {
    const base = '/Users/x/Library/Application Support/active-work'
    expect(provisionalName({ cwd: `${base}/relay` })).toBe('relay')
    expect(provisionalName({ cwd: `${base}/logan` })).toBe('logan')
    expect(provisionalName({ cwd: `${base}/claude-channels` })).toBe('claude-channels')
  })

  it('prefers the worktree over the repository, which is where confusion lives', () => {
    // Two sessions in two worktrees of one repo is the case where telling them
    // apart matters most, and both being called "agent-chat" helps nobody.
    const name = provisionalName({
      cwd: '/Users/x/projects/agent-chat/.worktrees/cc82',
      worktreePath: '/Users/x/projects/agent-chat/.worktrees/cc82',
    })
    expect(name).toBe('cc82')
  })

  it('falls back to the directory when there is no repository at all', () => {
    expect(provisionalName({ cwd: '/Users/x/scratch/notes' })).toBe('notes')
  })

  /**
   * `human`, `system` and friends carry authority in every peer's reading of
   * `from`. A directory that happens to be called `system` must not mint that.
   */
  it('never derives a reserved name', () => {
    expect(provisionalName({ cwd: '/Users/x/system' })).not.toBe('system')
    expect(provisionalName({ cwd: '/tmp/human' })).not.toBe('human')
  })

  it('sanitises what a directory name may contain but a session name may not', () => {
    expect(provisionalName({ cwd: '/Users/x/My Project (v2)' })).toBe('my-project-v2')
  })

  it('gives up rather than registering as something meaningless', () => {
    expect(provisionalName({ cwd: '/' })).toBeUndefined()
  })

  it('reads the slug from an active-work path wherever it sits', () => {
    expect(activeWorkSlug('/a/b/active-work/thing')).toBe('thing')
    expect(activeWorkSlug('/a/b/projects/thing')).toBeUndefined()
    expect(activeWorkSlug('/a/b/active-work')).toBeUndefined()
  })
})

describe('two sessions in one directory', () => {
  it('disambiguates from the session id, so a reconnect lands on the same name', () => {
    const first = disambiguated('relay', 'abcd-1234-efgh-5678', 99)
    expect(first).toBe(disambiguated('relay', 'abcd-1234-efgh-5678', 99))
    expect(first).toMatch(/^relay-5678$/)
  })

  it('falls back to the pid when there is no session id', () => {
    expect(disambiguated('relay', undefined, 4242)).toBe('relay-4242')
  })

  it('stays within the length a chosen name would have', () => {
    expect(disambiguated('a-very-long-initiative-name-indeed', 'zz99', 1).length).toBeLessThanOrEqual(24)
  })
})

describe('a derived name is marked, so it does not read as a declared one', () => {
  it('carries the mark onto the roster', () => {
    const registry = new Registry<Conn>()
    registry.register(conn(), {
      name: 'relay',
      workingOn: 'unregistered',
      cwd: '/tmp',
      pid: 1,
      provisional: true,
    })

    expect(registry.list()[0]?.provisional).toBe(true)
  })

  it('is absent, not false, for a name the session chose', () => {
    const registry = new Registry<Conn>()
    registry.register(conn(), { name: 'relay', workingOn: 'real work', cwd: '/tmp', pid: 1 })

    expect(registry.list()[0]?.provisional).toBeUndefined()
  })

  /** The rename chat_register performs: same connection, new name, mark gone. */
  it('is cleared when the session finally names itself', () => {
    const registry = new Registry<Conn>()
    const c = conn()
    registry.register(c, { name: 'relay', workingOn: 'unregistered', cwd: '/tmp', pid: 1, provisional: true })

    registry.register(c, { name: 'r70-credentials', workingOn: 'R-70', cwd: '/tmp', pid: 1 })

    const rows = registry.list()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe('r70-credentials')
    expect(rows[0]?.provisional).toBeUndefined()
  })
})
