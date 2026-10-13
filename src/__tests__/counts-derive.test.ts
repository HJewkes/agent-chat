import { describe, expect, it } from 'vitest'
import type { Claim, Ledger } from '../agents/burndown/ledger.js'
import { deriveCounts } from '../agents/counts/derive.js'
import { countVerdict } from '../agents/counts/explain.js'
import type { Count, CountId, LiveSnapshot, RosterRow, Verdict } from '../agents/counts/types.js'

const NOW = new Date('2030-01-01T12:00:00Z')
const TICK_MS = 20 * 60_000
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString()
const MIN = 60_000

const claim = (taskId: string, extra: Partial<Claim> = {}): Claim => ({
  taskId,
  initiative: 'demo',
  spawnedAt: ago(60 * MIN),
  phase: 'implementing',
  phaseAt: ago(60 * MIN),
  seat: 'seat-a',
  agentName: `sa-${taskId.toLowerCase()}`,
  ...extra,
})

const row = (
  name: string,
  state: RosterRow['state'] = 'live',
  extra: Partial<RosterRow> = {},
): RosterRow => ({
  agentId: `id-${name}`,
  name,
  profile: 'implementer',
  state,
  ...extra,
})

const ledger = (claims: Claim[]): Ledger => ({ version: 1, claims })

function snapshot(over: Partial<LiveSnapshot> = {}): LiveSnapshot {
  return {
    now: NOW,
    tickMs: TICK_MS,
    sweepMs: 10 * MIN,
    roster: { value: { rows: [] } },
    processes: { value: [] },
    sessions: { value: [] },
    fileClaims: { value: [] },
    worktrees: {},
    prs: {},
    shepherd: { value: { runs: [], reviewSlots: { running: [], cap: 3 } } },
    ledger: { value: ledger([]) },
    semaphore: { value: { held: 0, cap: 48 } },
    parkKept: { value: [] },
    ...over,
  }
}

const find = (counts: Count[], id: CountId, seat?: string): Count => {
  const found = counts.find(c => c.id === id && (seat === undefined || c.seat === seat))
  if (found === undefined) throw new Error(`no ${id} count`)
  return found
}

const verdictOf = (count: Count, key: string): Verdict => {
  const item = count.items.find(i => i.key === key)
  if (item === undefined) throw new Error(`no item ${key}`)
  return item.verdict
}

const exitedStale = (
  taskId: string,
  cls: NonNullable<Claim['stale']>['class'],
  since = ago(5 * MIN),
): Claim => claim(taskId, { stale: { class: cls, proposed: 'release', since } })

describe('counts derive: implementers', () => {
  it('counts no live implementers against eleven ledger claims, each with its own verdict', () => {
    const claims = [
      exitedStale('T-1', 'outside-owns'),
      exitedStale('T-2', 'outside-owns'),
      exitedStale('T-3', 'outside-owns'),
      exitedStale('T-4', 'outside-owns'),
      exitedStale('T-5', 'blocked'),
      exitedStale('T-6', 'nothing-to-do'),
      exitedStale('T-7', 'other', ago(3 * TICK_MS)),
      claim('T-8'),
      claim('T-9'),
      claim('T-10'),
      claim('T-11'),
    ]
    const rows = claims.map(c => row(c.agentName ?? '', 'exited'))

    const count = find(
      deriveCounts(snapshot({ ledger: { value: ledger(claims) }, roster: { value: { rows } } })),
      'implementers',
    )

    expect(count.live?.value).toBe(0)
    expect(count.shown).toContainEqual({ surface: 'ledger', value: 11 })
    const codes = (keys: string[]) =>
      keys.map(k => verdictOf(count, k)).map(v => (v.kind === 'explained' ? v.code : v.kind))
    expect(codes(['T-1', 'T-2', 'T-3', 'T-4', 'T-5'])).toEqual(Array(5).fill('escalated'))
    expect(codes(['T-6'])).toEqual(['stale-action-due'])
    expect(codes(['T-7', 'T-8', 'T-9', 'T-10', 'T-11'])).toEqual(Array(5).fill('unexplained'))
    expect(countVerdict(count)).toBe('unexplained')
  })

  it('agrees when every implementing claim has a live agent', () => {
    const claims = [claim('T-1'), claim('T-2')]
    const rows = [row('sa-t-1'), row('sa-t-2', 'detached')]

    const count = find(
      deriveCounts(snapshot({ ledger: { value: ledger(claims) }, roster: { value: { rows } } })),
      'implementers',
    )

    expect(count.live?.value).toBe(2)
    expect(countVerdict(count)).toBe('agree')
  })

  it('explains a spawning claim at nine minutes and not at eleven', () => {
    const spawning = (min: number) =>
      claim('T-1', {
        phase: 'spawning',
        nextPhase: 'implementing',
        phaseAt: ago(min * MIN),
        agentName: undefined,
      })
    const at = (min: number) =>
      verdictOf(
        find(deriveCounts(snapshot({ ledger: { value: ledger([spawning(min)]) } })), 'implementers'),
        'T-1',
      )

    expect(at(9)).toMatchObject({ kind: 'explained', code: 'spawning' })
    expect(at(11).kind).toBe('unexplained')
  })

  it('reads a missing row on a partial roster as unread, never live', () => {
    const roster = { value: { rows: [], partial: 'retired rows unread (timeout)' } }

    const count = find(
      deriveCounts(snapshot({ ledger: { value: ledger([claim('T-1')]) }, roster })),
      'implementers',
    )

    expect(verdictOf(count, 'T-1').kind).toBe('unread')
    expect(count.live?.value).toBe(0)
    expect(countVerdict(count)).toBe('unread')
  })

  it('leaves every role count unread when the roster read fails', () => {
    const counts = deriveCounts(
      snapshot({ ledger: { value: ledger([claim('T-1')]) }, roster: { error: 'timeout' } }),
    )

    expect(find(counts, 'implementers').live).toBeUndefined()
    expect(countVerdict(find(counts, 'implementers'))).toBe('unread')
  })

  it('shows the last tick row beside the live value', () => {
    const lastTick = {
      seats: {
        'seat-a': {
          roles: {
            used: { implementers: 4, reviewers: 0, planners: 0 },
            cap: { implementers: 8, reviewers: 2, planners: 1 },
          },
        },
      },
    }

    const count = find(
      deriveCounts(snapshot({ ledger: { value: ledger([claim('T-1')]) }, lastTick })),
      'implementers',
      'seat-a',
    )

    expect(count.shown).toContainEqual({ surface: 'tick', value: 4 })
  })
})

describe('counts derive: claims', () => {
  const shepherding = claim('T-1', {
    phase: 'shepherding',
    agentName: undefined,
    pr: 'https://example.test/pr/7',
  })
  const withPr = (state: 'open' | 'closed') =>
    snapshot({
      ledger: { value: ledger([shepherding]) },
      prs: { 'demo/repo': { value: [{ pr: 'https://example.test/pr/7', state }] } },
      shepherd: { value: { runs: [{ pr: 'https://example.test/pr/7', ended: false }] } },
    })

  it('holds a shepherding claim in review while its PR is open and its run has not ended', () => {
    const count = find(deriveCounts(withPr('open')), 'claims')

    expect(verdictOf(count, 'T-1')).toMatchObject({ kind: 'explained', code: 'in-review' })
    expect(count.live?.value).toBe(1)
  })

  it('reports a shepherding claim whose PR is closed as unexplained', () => {
    const count = find(deriveCounts(withPr('closed')), 'claims')

    expect(verdictOf(count, 'T-1')).toMatchObject({
      kind: 'unexplained',
      why: expect.stringContaining('closed'),
    })
  })

  it('reads a PR from a failed repo read as unread', () => {
    const snap = snapshot({
      ledger: { value: ledger([shepherding]) },
      prs: { 'demo/repo': { error: 'gh: rate limited' } },
    })

    expect(verdictOf(find(deriveCounts(snap), 'claims'), 'T-1').kind).toBe('unread')
  })

  it('explains queued slices and a parked claim with a question', () => {
    const claims = [
      claim('T-1', { phase: 'queued', slice: 'b', agentName: undefined }),
      claim('T-2', { phase: 'parked', questionId: 'q-1' }),
    ]

    const count = find(deriveCounts(snapshot({ ledger: { value: ledger(claims) } })), 'claims')

    expect(verdictOf(count, 'T-1 b')).toMatchObject({ code: 'slices-queued' })
    expect(verdictOf(count, 'T-2')).toMatchObject({ code: 'parked-claim' })
    expect(countVerdict(count)).toBe('explained')
  })
})

describe('counts derive: worktrees', () => {
  const TREE = '/tmp/demo/.worktrees/sa-t-1'
  const trees = (over: Partial<LiveSnapshot>) =>
    find(
      deriveCounts(
        snapshot({
          roster: { value: { rows: [row('sa-t-1', 'exited', { cwd: TREE })] } },
          worktrees: { 'demo/repo': { value: [{ path: TREE }] } },
          ...over,
        }),
      ),
      'worktrees',
    )

  it('explains an exited agent tree kept by a recent ignored-files park refusal', () => {
    const parkKept = {
      value: [{ tree: TREE, class: 'ignored-files' as const, reason: 'ignored files', at: ago(5 * MIN) }],
    }

    expect(verdictOf(trees({ parkKept }), TREE)).toMatchObject({ kind: 'explained', code: 'park-refused' })
  })

  it('reports an exited agent tree with no park-kept reason as unexplained', () => {
    expect(verdictOf(trees({}), TREE).kind).toBe('unexplained')
  })

  it('explains a tree a held claim keeps', () => {
    const ledgerRead = { value: ledger([claim('T-1', { worktree: TREE })]) }

    expect(verdictOf(trees({ ledger: ledgerRead }), TREE)).toMatchObject({ code: 'park-held' })
  })

  it('agrees on a live agent tree and counts every tree on disk', () => {
    const count = trees({ roster: { value: { rows: [row('sa-t-1', 'live', { cwd: TREE })] } } })

    expect(count.live?.value).toBe(1)
    expect(countVerdict(count)).toBe('agree')
  })
})

describe('counts derive: slots', () => {
  const live = Array.from({ length: 13 }, (_, i) => row(`sa-${i}`))
  const agentProcs = live.map((r, i) => ({ pid: 100 + i, agentId: r.agentId, name: r.name }))
  const sessionProcs = ['seat-a', 'seat-b', 'seat-c', 'human'].map((name, i) => ({ pid: 200 + i, name }))
  const slots = (extra: { pid: number; name?: string }[]) =>
    find(
      deriveCounts(
        snapshot({
          roster: { value: { rows: live } },
          processes: { value: [...agentProcs, ...sessionProcs, ...extra] },
          sessions: { value: ['seat-a', 'seat-b', 'seat-c', 'human'] },
          semaphore: { value: { held: 13, cap: 48 } },
        }),
      ),
      'slots',
    )

  it('explains seventeen processes against thirteen slots by four seat or human sessions', () => {
    const count = slots([])

    expect(count.live?.value).toBe(17)
    expect(count.shown).toContainEqual({ surface: 'agent ls', value: 13 })
    expect(countVerdict(count)).toBe('explained')
  })

  it('reports a fifth unaccounted process as unexplained', () => {
    const count = slots([{ pid: 999, name: 'stray' }])

    expect(verdictOf(count, 'pid 999 stray').kind).toBe('unexplained')
  })
})

describe('counts derive: file claims and Shepherd reviewers', () => {
  it('reports a file claim whose owner exited as a leak', () => {
    const snap = snapshot({
      roster: { value: { rows: [row('sa-t-1', 'exited')] } },
      fileClaims: { value: [{ owner: 'sa-t-1', repo: 'demo/repo', patterns: ['src/**'] }] },
    })

    const count = find(deriveCounts(snap), 'file-claims')

    expect(count.items[0]?.verdict).toMatchObject({
      kind: 'unexplained',
      why: expect.stringContaining('leaked file claim'),
    })
  })

  it('agrees on a file claim held by a live session', () => {
    const snap = snapshot({
      sessions: { value: ['seat-a'] },
      fileClaims: { value: [{ owner: 'seat-a', repo: 'demo/repo', patterns: ['docs/**'] }] },
    })

    expect(countVerdict(find(deriveCounts(snap), 'file-claims'))).toBe('agree')
  })

  it('reads Shepherd reviewers as unread when Shepherd exports no slot reading', () => {
    const count = find(deriveCounts(snapshot({ shepherd: { value: { runs: [] } } })), 'shepherd-reviewers')

    expect(count.live).toBeUndefined()
  })

  it('compares Shepherd running reviewers with live rv- rows', () => {
    const snap = snapshot({
      roster: { value: { rows: [row('rv-1'), row('rv-2')] } },
      shepherd: { value: { runs: [], reviewSlots: { running: ['rv-1'], cap: 3 } } },
    })

    const count = find(deriveCounts(snap), 'shepherd-reviewers')

    expect(count.live?.value).toBe(2)
    expect(verdictOf(count, 'rv-2').kind).toBe('unexplained')
  })
})
