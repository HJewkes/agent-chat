import { describe, expect, it } from 'vitest'
import type { Claim } from '../agents/burndown/ledger.js'
import { deriveCounts } from '../agents/counts/derive.js'
import {
  keptClass,
  parseParkKept,
  parsePrSnapshot,
  parseProcesses,
  parseShepherdStatus,
  prKeys,
  readLive,
  type LiveReaders,
} from '../agents/counts/read-live.js'
import { COUNT_IDS, type RosterRow } from '../agents/counts/types.js'
import { countsReport } from '../cli/verbs/counts.js'

const NOW = new Date('2030-01-01T12:00:00Z')
const MIN = 60_000
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString()
const REPO = '/srv/demo'
const TREE = `${REPO}/.worktrees/t-1`

const claim = (taskId: string, extra: Partial<Claim> = {}): Claim => ({
  taskId,
  initiative: 'demo',
  spawnedAt: ago(60 * MIN),
  phase: 'implementing',
  phaseAt: ago(60 * MIN),
  seat: 'seat-a',
  agentName: `sa-${taskId.toLowerCase()}`,
  agentId: `id-sa-${taskId.toLowerCase()}`,
  ...extra,
})

const row = (name: string, extra: Partial<RosterRow> = {}): RosterRow => ({
  agentId: `id-${name}`,
  name,
  profile: 'implementer',
  state: 'live',
  ...extra,
})

const roles = { implementers: 1, reviewers: 0, planners: 0 }

/** One seat, one repo, one live implementer in its tree and one live Shepherd reviewer: every count agrees. */
function readers(over: Partial<LiveReaders> = {}): LiveReaders {
  return {
    now: () => NOW,
    tickMs: 10 * MIN,
    sweepMs: 10 * MIN,
    roster: async () => ({
      roster: { rows: [row('sa-t-1', { cwd: TREE }), row('rv-demo-1', { profile: 'reviewer' })] },
      semaphore: { held: 2, cap: 48 },
    }),
    list: async () => ({
      sessions: ['sa-t-1'],
      fileClaims: [{ owner: 'sa-t-1', repo: REPO, patterns: ['src/**'] }],
    }),
    processes: async () => [
      { pid: 101, agentId: 'id-sa-t-1', name: 'sa-t-1' },
      { pid: 102, agentId: 'id-rv-demo-1', name: 'rv-demo-1' },
    ],
    seatRepos: async () => [REPO],
    worktrees: async () => [{ path: TREE, branch: 'demo/t-1' }],
    shepherdPrs: async () => ({ at: ago(MIN), byRepo: {} }),
    ghPrs: async () => {
      throw new Error('gh read while the snapshot is fresh')
    },
    shepherd: async () => ({ runs: [], reviewSlots: { running: ['rv-demo-1'], cap: 3 } }),
    ledger: async () => ({ version: 1, claims: [claim('T-1')] }),
    lastTick: async () => ({ seats: { 'seat-a': { roles: { used: roles, cap: roles } } } }),
    parkKept: async () => [],
    ...over,
  }
}

const headLines = (lines: string[]): string[] => lines.filter(l => !l.startsWith('  '))

describe('counts verb', () => {
  it('exits 0 when every count agrees, printing each count id once', async () => {
    const report = await countsReport(readers(), { check: true })

    expect(report).toMatchObject({ ok: true })
    for (const id of COUNT_IDS) {
      const heads = headLines(report.lines).filter(l => l.startsWith(`${id} `) || l.startsWith(`${id}:`))
      expect(heads, id).toHaveLength(1)
      expect(heads[0], id).toMatch(/· agree$/)
    }
  })

  it('exits 1 on an unexplained ledger claim and names it on its own line', async () => {
    const ledger = async () => ({ version: 1 as const, claims: [claim('T-1'), claim('T-2')] })

    const report = await countsReport(readers({ ledger }), { check: true })

    expect(report).toMatchObject({ ok: false, exit: 1 })
    expect(report.lines).toContainEqual(expect.stringMatching(/^ {2}UNEXPLAINED: T-2 \(implementing claim/))
  })

  it('exits 2 and prints unread when the gh fallback for a stale snapshot throws', async () => {
    let ghCalls = 0
    const ghPrs = async () => {
      ghCalls++
      throw new Error('gh: HTTP 502')
    }
    const shepherding = claim('T-3', { phase: 'shepherding', pr: 'demo/demo#7', agentName: 'sa-gone' })
    const ledger = async () => ({ version: 1 as const, claims: [claim('T-1'), shepherding] })
    const stale = async () => ({ at: ago(11 * MIN), byRepo: {} })

    const report = await countsReport(readers({ ghPrs, ledger, shepherdPrs: stale }), { check: true })

    expect(report).toMatchObject({ ok: false, exit: 2 })
    expect(report.lines).toContainEqual(expect.stringMatching(/^claims seat seat-a: .*· unread$/))
    expect(report.lines).toContainEqual(
      expect.stringMatching(/^ {2}unread: T-3 \(PR demo\/demo#7: gh: HTTP 502\)/),
    )
    expect(ghCalls).toBe(1)
  })

  it('prints exactly K1 counts under --json', async () => {
    const r = readers({ ledger: async () => ({ version: 1, claims: [claim('T-1'), claim('T-2')] }) })

    const report = await countsReport(r, { json: true })

    const parsed = JSON.parse(report.lines.join('\n')) as unknown
    expect(parsed).toEqual({ exit: 1, counts: deriveCounts(await readLive(r)) })
  })

  it('exits 2 when Shepherd exports no reviewer-slot reading', async () => {
    const shepherd = async () => parseShepherdStatus('[]')

    const report = await countsReport(readers({ shepherd }), { check: true })

    expect(report).toMatchObject({ ok: false, exit: 2 })
    expect(report.lines).toContain('shepherd-reviewers: live unread · unread')
  })

  it('keeps only the asked seat beside the machine-wide counts', async () => {
    const ledger = async () => ({
      version: 1 as const,
      claims: [claim('T-1'), claim('T-9', { seat: 'seat-b', agentName: 'sb-t-9' })],
    })

    const report = await countsReport(readers({ ledger }), { seat: 'seat-a' })

    expect(report.lines.some(l => l.includes('seat seat-b'))).toBe(false)
    expect(report.lines.some(l => l.startsWith('slots:'))).toBe(true)
  })
})

describe('counts live readers', () => {
  it('reads claude processes with their agent id and name, skipping everything else', () => {
    const ps = [
      '  PID ARGS',
      ' 101 /opt/bin/claude --settings /srv/state/agents/a1b2/settings.json --name sa-t-1',
      ' 102 /opt/bin/claude --name=seat-a',
      ' 103 node /opt/bin/claude-helper --name x',
      ' 104 grep claude',
    ].join('\n')

    expect(parseProcesses(ps)).toEqual([
      { pid: 101, agentId: 'a1b2', name: 'sa-t-1' },
      { pid: 102, name: 'seat-a' },
    ])
  })

  it('classes park-kept log lines and skips other events', () => {
    const log = [
      '{"ts":"2030-01-01T11:00:00Z","event":"implementer_park_kept","agentId":"a1","reason":"burndown claim T-1 slice a holds the tree in phase implementing"}',
      '{"ts":"2030-01-01T11:01:00Z","event":"implementer_parked","agentId":"a2"}',
      'not json _park_kept',
    ].join('\n')

    expect(parseParkKept(log)).toEqual([
      {
        agentId: 'a1',
        reason: 'burndown claim T-1 slice a holds the tree in phase implementing',
        at: '2030-01-01T11:00:00Z',
      },
    ])
    expect(keptClass('ignored files in /srv/demo would be deleted')).toBe('ignored-files')
    expect(keptClass('database is not open')).toBe('error')
  })

  it('dates the PR snapshot by its newest snapshot row and keys each PR both ways', () => {
    const json = JSON.stringify([
      { repo: 'demo/demo', number: 7, state: 'open', source: 'snapshot', at: '2030-01-01T11:58:00Z' },
      { repo: 'demo/demo', number: 6, state: 'merged', source: 'merge-step', at: '2030-01-01T11:59:00Z' },
    ])

    const snapshot = parsePrSnapshot(json)

    expect(snapshot.at).toBe('2030-01-01T11:58:00Z')
    expect(snapshot.byRepo['demo/demo']?.map(r => r.pr)).toEqual([
      ...prKeys('demo/demo', 7),
      ...prKeys('demo/demo', 6),
    ])
  })

  it('reads a K14 status object and drops a slot reading that carries a roster error', () => {
    const run = { repo: 'demo/demo', pr: 7, runId: 'r1', phase: 'review', headSha: null, stalled: null }
    const ok = JSON.stringify({ runs: [run], reviewSlots: { running: ['rv-demo-1'], cap: 3 } })
    const failed = JSON.stringify({ runs: [run], reviewSlots: { cap: 3, rosterError: 'timeout' } })

    expect(parseShepherdStatus(ok).reviewSlots).toEqual({ running: ['rv-demo-1'], cap: 3 })
    expect(parseShepherdStatus(ok).runs).toEqual(prKeys('demo/demo', 7).map(pr => ({ pr, ended: false })))
    expect(parseShepherdStatus(failed).reviewSlots).toBeUndefined()
    expect(() => parseShepherdStatus('{}')).toThrow(/no run list/)
  })
})
