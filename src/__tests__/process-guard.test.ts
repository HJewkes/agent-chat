import { describe, expect, it } from 'vitest'
import { runawayVictims } from '../agents/process-guard.js'
import type { ProcRow } from '../broker/reaper.js'

const UID = 1000
const BROKER = 100
const GIB_KB = 1024 ** 2
const LIMIT = 8 * 1024 ** 3
const OPTS = { brokerPid: BROKER, uid: UID }

function row(pid: number, ppid: number, command: string, rssGib = 0.1, uid = UID): ProcRow {
  return { pid, ppid, uid, startMs: 0, rssKb: Math.round(rssGib * GIB_KB), command }
}

const init = row(1, 0, '/sbin/init')
const broker = row(BROKER, 1, '/usr/bin/node /opt/agent/projects/agent-chat/dist/cli.js broker')
const claude = row(200, BROKER, '/opt/agent/.local/bin/claude --model opus --session-id abc')

function victimPids(rows: ProcRow[]): Array<[number, number]> {
  return runawayVictims(rows, LIMIT, OPTS).map(v => [v.row.pid, v.root.pid])
}

describe('runaway victim selection (CC-495)', () => {
  it('a git under a claude process at 9 GB is a victim', () => {
    const rows = [init, broker, claude, row(300, 200, '/usr/bin/zsh -c git gc'), row(400, 300, 'git gc', 9)]

    expect(victimPids(rows)).toEqual([[400, 200]])
  })

  it('a process just under the limit is left alone', () => {
    const rows = [init, broker, claude, row(400, 200, 'git gc', 7.9)]

    expect(victimPids(rows)).toEqual([])
  })

  it('the claude process itself at 9 GB is not a victim', () => {
    const rows = [init, broker, { ...claude, rssKb: 9 * GIB_KB }]

    expect(victimPids(rows)).toEqual([])
  })

  it('a 9 GB process with no root ancestor is left alone', () => {
    const rows = [
      init,
      broker,
      row(50, 1, '/usr/lib/systemd/systemd --user'),
      row(500, 50, 'python3 train.py', 9),
      row(600, 1, '/usr/bin/node /opt/other/server.js', 9),
    ]

    expect(victimPids(rows)).toEqual([])
  })

  it('a ppid cycle in the ps output terminates', () => {
    const rows = [init, broker, row(500, 501, 'python3 a.py', 9), row(501, 500, 'python3 b.py', 9)]

    expect(victimPids(rows)).toEqual([])
  })

  it('a node process running titan-factory is a root and its 9 GB child is a victim', () => {
    const viaShim = row(700, 1, 'node /opt/agent/.local/bin/titan-factory shepherd hold x')
    const service = row(
      710,
      1,
      '/usr/bin/node /opt/agent/projects/titan-platform/products/factory/dist/bin.js serve',
    )
    const rows = [init, broker, viaShim, service, row(701, 700, 'vitest', 9), row(711, 710, 'vitest', 9)]

    expect(victimPids(rows)).toEqual([
      [701, 700],
      [711, 710],
    ])
  })

  it('a grep whose argv mentions titan-factory is not a root', () => {
    const rows = [init, broker, row(800, 1, 'grep -i titan-factory'), row(801, 800, 'cat', 9)]

    expect(victimPids(rows)).toEqual([])
  })

  it('a process of another uid is never a victim', () => {
    const rows = [init, broker, claude, row(400, 200, 'git gc', 9, 0)]

    expect(victimPids(rows)).toEqual([])
  })

  it("the broker's own ancestors are never victims", () => {
    const outerClaude = row(20, 1, '/opt/agent/.local/bin/claude')
    const shell = row(30, 20, '/usr/bin/zsh', 9)
    const rows = [init, outerClaude, shell, { ...broker, ppid: 30 }]

    expect(victimPids(rows)).toEqual([])
  })
})
