import { describe, expect, it } from 'vitest'
import { recordClaudeBin, resolveClaudeBin } from '../agents/claude-bin.js'

/**
 * CC-132. A headless spawn calls `spawn('claude', ...)`, which Node resolves
 * against the child's `PATH` — and a broker autostarted by a session with a
 * minimal `PATH` has no `claude` on it, so every headless spawn died with exit
 * 127. This resolver mirrors `agent-chat-launch.sh`'s `resolve_node` order for
 * `claude`, so the launcher stops depending on `PATH` alone.
 */

const STATE_DIR = '/state'

/** The paths that exist in these tests. Injected, so nothing here touches real disk. */
const exists =
  (...paths: string[]) =>
  (candidate: string) =>
    paths.includes(candidate)

describe('resolving the claude binary', () => {
  it('takes AGENT_CHAT_CLAUDE over everything else', () => {
    const override = '/custom/claude'
    const resolved = resolveClaudeBin({
      env: { AGENT_CHAT_CLAUDE: override, PATH: '/usr/local/bin' },
      stateDir: STATE_DIR,
      exists: exists(override, '/usr/local/bin/claude'),
    })

    expect(resolved).toEqual({ bin: override, source: 'env' })
  })

  it('falls to claude on PATH when there is no override', () => {
    const resolved = resolveClaudeBin({
      env: { PATH: '/usr/bin:/opt/homebrew/bin' },
      stateDir: STATE_DIR,
      exists: exists('/opt/homebrew/bin/claude'),
    })

    expect(resolved).toEqual({ bin: '/opt/homebrew/bin/claude', source: 'path' })
  })

  it('falls to the state-dir file when PATH has nothing', () => {
    const recorded = '/recorded/claude'
    const resolved = resolveClaudeBin({
      env: { PATH: '/usr/bin' },
      stateDir: STATE_DIR,
      exists: exists(recorded),
      readFirstLine: file => (file === `${STATE_DIR}/claude-path` ? recorded : undefined),
    })

    expect(resolved).toEqual({ bin: recorded, source: 'state-file' })
  })

  it('falls to the usual install locations last', () => {
    const resolved = resolveClaudeBin({
      env: { PATH: '/usr/bin', HOME: '/Users/test' },
      stateDir: STATE_DIR,
      exists: exists('/Users/test/.local/bin/claude'),
      readFirstLine: () => undefined,
    })

    expect(resolved).toEqual({ bin: '/Users/test/.local/bin/claude', source: 'well-known' })
  })

  it('reports every candidate tried when nothing is found', () => {
    const resolved = resolveClaudeBin({
      env: { AGENT_CHAT_CLAUDE: '/nope/claude', PATH: '/usr/bin', HOME: '/Users/test' },
      stateDir: STATE_DIR,
      exists: exists(),
      readFirstLine: () => undefined,
    })

    expect(resolved).toEqual({
      error: expect.stringContaining('cannot find the claude binary'),
      tried: expect.arrayContaining([
        '/nope/claude',
        '/usr/bin/claude',
        `${STATE_DIR}/claude-path`,
        '/opt/homebrew/bin/claude',
        '/Users/test/.local/bin/claude',
        '/usr/local/bin/claude',
      ]),
    })
  })

  /**
   * The step CC-132 exists to add, and the one a mutation dropping it would miss:
   * without PATH outranking the state file, a stale recorded path could win over
   * a `claude` that is right there on PATH.
   */
  it('prefers PATH over a stale recorded path', () => {
    const resolved = resolveClaudeBin({
      env: { PATH: '/opt/homebrew/bin' },
      stateDir: STATE_DIR,
      exists: exists('/opt/homebrew/bin/claude', '/stale/claude'),
      readFirstLine: file => (file === `${STATE_DIR}/claude-path` ? '/stale/claude' : undefined),
    })

    if ('error' in resolved) throw new Error(`expected a resolution, got: ${resolved.error}`)
    expect(resolved).toEqual({ bin: '/opt/homebrew/bin/claude', source: 'path' })
  })
})

describe('recording a resolved path', () => {
  it('writes the resolved path so a later minimal-PATH broker finds it', () => {
    const writes: Array<[string, string]> = []
    recordClaudeBin(STATE_DIR, '/opt/homebrew/bin/claude', (file, data) => writes.push([file, data]))

    expect(writes).toEqual([[`${STATE_DIR}/claude-path`, '/opt/homebrew/bin/claude\n']])
  })

  it('never throws when the write fails', () => {
    expect(() =>
      recordClaudeBin(STATE_DIR, '/opt/homebrew/bin/claude', () => {
        throw new Error('disk full')
      }),
    ).not.toThrow()
  })
})
