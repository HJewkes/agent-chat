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

  it('spares the running broker itself', () => {
    const table = [row(100, 'node (vitest 1)')]

    expect(selectOrphans(table, opts)).toEqual([])
  })

  it('spares an ancestor of the running broker', () => {
    const table = [row(100, 'zsh', { ppid: 50 }), row(50, 'node (vitest 2)')]

    expect(selectOrphans(table, opts)).toEqual([])
  })

  it('spares an orphaned test broker, which is out of scope', () => {
    const table = [row(200, `${NODE} /r/.worktrees/x/dist/cli.js broker`)]

    expect(selectOrphans(table, opts)).toEqual([])
  })

  it('spares a claude session whose argv only mentions the target scripts', () => {
    const command =
      'claude --append-system-prompt run /w/scripts/dag-check-self.mjs and /w/node_modules/vitest/dist/workers/forks.js'
    const table = [row(200, command)]

    expect(selectOrphans(table, opts)).toEqual([])
  })

  it('spares a node process running another script that mentions the targets later', () => {
    const table = [
      row(200, `${NODE} /w/other.js /w/scripts/dag-check-self.mjs`),
      row(201, `${NODE} /w/other.js /w/node_modules/vitest/dist/workers/forks.js`),
    ]

    expect(selectOrphans(table, opts)).toEqual([])
  })

  it('spares a title that only starts like a vitest worker', () => {
    const table = [row(200, 'node (vitest 3) --extra'), row(201, 'claude node (vitest 3)')]

    expect(selectOrphans(table, opts)).toEqual([])
  })

  it('spares a dag-check script outside a scripts directory', () => {
    const table = [row(200, `${NODE} /w/lib/dag-check-self.mjs`)]

    expect(selectOrphans(table, opts)).toEqual([])
  })

  it('spares unrelated orphans', () => {
    const table = [row(200, `${NODE} /w/server.js`), row(201, 'vim notes.txt')]

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

describe('junk etime', () => {
  it('drops a row whose etime cannot be parsed so it is never reaped', () => {
    const rows = parseTable('  42     1   501 garbage  2048 node (vitest 2)\n', NOW)

    expect(rows).toEqual([])
  })

  it('spares a row whose start time is not a number', () => {
    const table = [row(200, 'node (vitest 1)', { startMs: Number.NaN })]

    expect(selectOrphans(table, opts)).toEqual([])
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
  it('kills each orphan and logs pid, cwd and rss once', async () => {
    const kill = vi.fn()
    const log = vi.fn()
    const table = [row(200, 'node (vitest 1)', { rssKb: 1900 }), row(201, 'zsh')]

    const reaped = await reapOnce({
      readTable: async () => table,
      kill,
      log,
      cwdOf: async pid => `/w/${pid}`,
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

  it('reads the cwd before the signal and truncates the logged command', async () => {
    const order: string[] = []
    const log = vi.fn()

    await reapOnce({
      readTable: async () => [
        row(200, 'node (vitest 1)'),
        row(201, `${NODE} /w/scripts/dag-check-self.mjs ${'x'.repeat(500)}`),
      ],
      kill: pid => order.push(`kill ${pid}`),
      log,
      cwdOf: async pid => {
        order.push(`cwd ${pid}`)
        return '/w'
      },
      options: () => opts,
    })

    expect(order).toEqual(['cwd 200', 'kill 200', 'cwd 201', 'kill 201'])
    expect(log.mock.calls[1]?.[0].command).toHaveLength(200)
  })

  it('does not log a process whose kill failed', async () => {
    const log = vi.fn()

    await reapOnce({
      readTable: async () => [row(200, 'node (vitest 1)')],
      kill: () => {
        throw new Error('ESRCH')
      },
      log,
      cwdOf: async () => '?',
      options: () => opts,
    })

    expect(log).not.toHaveBeenCalled()
  })
})

describe('startReaper', () => {
  it('sweeps every interval until cancelled', async () => {
    vi.useFakeTimers()
    const readTable = vi.fn(async () => [])
    const cancel = startReaper(
      { readTable, kill: vi.fn(), log: vi.fn(), cwdOf: async () => '?', options: () => opts },
      60_000,
    )

    await vi.advanceTimersByTimeAsync(180_000)
    cancel()
    await vi.advanceTimersByTimeAsync(180_000)

    expect(readTable).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
  })
})
