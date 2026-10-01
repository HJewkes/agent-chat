import { describe, expect, it, vi } from 'vitest'
import {
  parseEtime,
  parseTable,
  reapOnce,
  selectOrphans,
  startReaper,
  type ProcRow,
  type SelectOptions,
} from '../broker/reaper.js'

const NOW = 1_000_000_000
const ME = 501
const INSTALLED = '/opt/synthetic/agent-chat/dist/cli.js'
const NODE = '/usr/local/bin/node'

const opts: SelectOptions = {
  uid: ME,
  now: NOW,
  minAgeMs: 120_000,
  selfPid: 100,
  excludePaths: [INSTALLED],
}

function row(pid: number, command: string, over: Partial<ProcRow> = {}): ProcRow {
  return { pid, ppid: 1, uid: ME, startMs: NOW - 300_000, rssKb: 1000, command, ...over }
}

const matching: Array<[string, string]> = [
  ['vitest title', 'node (vitest 3)'],
  ['vitest forks worker', `${NODE} /w/node_modules/vitest/dist/workers/forks.js`],
  ['vitest threads worker', `${NODE} /w/node_modules/vitest/dist/workers/threads.js`],
  ['dag-check plain', `${NODE} /w/scripts/dag-check-self.mjs`],
  ['dag-check json', `${NODE} /w/scripts/dag-check-self.mjs --json`],
  ['dag-check heap flag', `${NODE} --max-old-space-size=4096 /w/scripts/dag-check-self.mjs --json`],
  ['test broker in worktree', `${NODE} /r/.worktrees/x/dist/cli.js broker`],
  ['test broker in tmp', `${NODE} /tmp/build/dist/cli.js broker`],
]

describe('selectOrphans', () => {
  it.each(matching)('selects an old orphaned %s', (_name, command) => {
    const table = [row(200, command)]

    expect(selectOrphans(table, opts).map(r => r.pid)).toEqual([200])
  })

  it('spares a process whose parent is alive', () => {
    const table = [row(200, 'node (vitest 1)', { ppid: 150 }), row(150, 'zsh', { ppid: 90 })]

    expect(selectOrphans(table, opts)).toEqual([])
  })

  it('spares a process younger than the minimum age', () => {
    const table = [row(200, 'node (vitest 1)', { startMs: NOW - 119_000 })]

    expect(selectOrphans(table, opts)).toEqual([])
  })

  it('reaps a process exactly at the minimum age', () => {
    const table = [row(200, 'node (vitest 1)', { startMs: NOW - 120_000 })]

    expect(selectOrphans(table, opts)).toHaveLength(1)
  })

  it('spares a process owned by another uid', () => {
    const table = [row(200, 'node (vitest 1)', { uid: 0 })]

    expect(selectOrphans(table, opts)).toEqual([])
  })

  it('spares the installed broker even though it is an old orphan', () => {
    const table = [row(200, `${NODE} ${INSTALLED} broker`)]

    expect(selectOrphans(table, opts)).toEqual([])
  })

  it('spares an orphaned broker outside any throwaway directory', () => {
    const table = [row(200, `${NODE} /srv/other/dist/cli.js broker`)]

    expect(selectOrphans(table, opts)).toEqual([])
  })

  it('spares the running broker itself', () => {
    const table = [row(100, `${NODE} /r/.worktrees/x/dist/cli.js broker`)]

    expect(selectOrphans(table, opts)).toEqual([])
  })

  it('spares an ancestor of the running broker', () => {
    const table = [
      row(100, `${NODE} /r/.worktrees/x/dist/cli.js broker`, { ppid: 50 }),
      row(50, `${NODE} /tmp/y/dist/cli.js broker`),
    ]

    expect(selectOrphans(table, opts)).toEqual([])
  })

  it('spares unrelated orphans', () => {
    const table = [row(200, `${NODE} /w/server.js`), row(201, 'vim notes.txt')]

    expect(selectOrphans(table, opts)).toEqual([])
  })

  it('spares a non-broker cli.js command under a worktree', () => {
    const table = [row(200, `${NODE} /r/.worktrees/x/dist/cli.js run-agent abc`)]

    expect(selectOrphans(table, opts)).toEqual([])
  })
})

describe('parseEtime', () => {
  it.each([
    ['05:33', (5 * 60 + 33) * 1000],
    ['01:02:03', (3600 + 120 + 3) * 1000],
    ['2-03:04:05', (2 * 86400 + 3 * 3600 + 4 * 60 + 5) * 1000],
  ])('parses %s', (text, ms) => {
    expect(parseEtime(text)).toBe(ms)
  })
})

describe('parseTable', () => {
  it('reads pid, ppid, uid, start, rss and the full command', () => {
    const text = `  42     1   501 05:33  2048 node (vitest 2)\n  43    42   501 00:05    10 ${NODE} a b\n`

    const rows = parseTable(text, NOW)

    expect(rows[0]).toEqual({
      pid: 42,
      ppid: 1,
      uid: 501,
      startMs: NOW - 333_000,
      rssKb: 2048,
      command: 'node (vitest 2)',
    })
    expect(rows[1]?.command).toBe(`${NODE} a b`)
  })
})

describe('reapOnce', () => {
  it('kills each orphan and logs pid, cwd and rss once', () => {
    const kill = vi.fn()
    const log = vi.fn()
    const table = [row(200, 'node (vitest 1)', { rssKb: 1900 }), row(201, 'zsh')]

    const reaped = reapOnce({
      readTable: () => table,
      kill,
      log,
      cwdOf: pid => `/w/${pid}`,
      options: () => opts,
    })

    expect(reaped).toEqual([200])
    expect(kill).toHaveBeenCalledOnce()
    expect(kill).toHaveBeenCalledWith(200)
    expect(log).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith({
      pid: 200,
      cwd: '/w/200',
      rssKb: 1900,
      command: 'node (vitest 1)',
    })
  })

  it('does not log a process whose kill failed', () => {
    const log = vi.fn()

    reapOnce({
      readTable: () => [row(200, 'node (vitest 1)')],
      kill: () => {
        throw new Error('ESRCH')
      },
      log,
      cwdOf: () => '?',
      options: () => opts,
    })

    expect(log).not.toHaveBeenCalled()
  })
})

describe('startReaper', () => {
  it('sweeps every interval until cancelled', () => {
    vi.useFakeTimers()
    const readTable = vi.fn(() => [])
    const cancel = startReaper(
      { readTable, kill: vi.fn(), log: vi.fn(), cwdOf: () => '?', options: () => opts },
      60_000,
    )

    vi.advanceTimersByTime(180_000)
    cancel()
    vi.advanceTimersByTime(180_000)

    expect(readTable).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
  })
})
