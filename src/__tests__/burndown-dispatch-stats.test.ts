import { describe, expect, it } from 'vitest'
import {
  dispatchStats,
  readyFloor,
  journalRefusals,
  parseWindow,
  briefSourceQuality,
  type BriefSourceQuality,
  type DispatchStatsPorts,
  type SeatDispatchStats,
} from '../agents/burndown/dispatch-stats.js'
import type { Claim, Ledger } from '../agents/burndown/ledger.js'
import type { SeatSummary, TickSummaryRow } from '../agents/burndown/tick-summary.js'
import { dispatchStatsLines } from '../cli/verbs/burndown.js'

/** CC-933 (item 179 S9): `burndown dispatch-stats` over fixture logs. */

const NOW = new Date(2026, 1, 3, 12, 0)
const DAY_MS = 86_400_000
const ago = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString()

const summary = (extra: Partial<SeatSummary> = {}): SeatSummary => ({
  ready: 2,
  unbriefed: 5,
  stale: 1,
  dispatched: 0,
  refusals: { 'out-of-scope': 40, trust: 7 },
  roles: {
    used: { implementers: 2, reviewers: 0, planners: 1 },
    cap: { implementers: 3, reviewers: 2, planners: 1 },
  },
  registrations: { ok: 1, refused: 1, failed: 0 },
  ...extra,
})

const row = (minutesAgo: number, seats: Record<string, SeatSummary>): string =>
  JSON.stringify({
    v: 1,
    ts: ago(minutesAgo),
    registrations: { ok: 0, refused: 0, failed: 0 },
    seats,
  } satisfies TickSummaryRow)

const spawnRow = (agent: string, spawner: string, minutesAgo: number): string =>
  JSON.stringify({
    ts: ago(minutesAgo),
    agent,
    agent_id: agent,
    outcome: 'dispatched',
    by: 'broker',
    spawner,
  })

const claim = (taskId: string, seat: string, phase: Claim['phase'], minutesAgo: number): Claim => ({
  taskId,
  initiative: 'demo',
  spawnedAt: ago(minutesAgo),
  phase,
  phaseAt: ago(minutesAgo),
  seat,
})

const LEDGER: Ledger = {
  version: 1,
  claims: [
    claim('AB-1', 'sa', 'queued', 10),
    claim('AB-2', 'sa', 'queued', 30),
    claim('AB-3', 'sa', 'queued', 50),
    claim('AB-4', 'sa', 'implementing', 90),
    claim('AB-5', 'sb', 'queued', 5),
  ],
} as Ledger

const TICKS = [
  row(DAY_MS / 60_000 + 30, { sa: summary({ registrations: { ok: 9, refused: 9, failed: 9 } }) }),
  'not json',
  JSON.stringify({ v: 2, ts: ago(1), seats: {} }),
  row(20, { sa: summary({ dispatched: 1 }), sb: summary({ skipped: 'seat file unreadable' }) }),
  row(10, { sa: summary({ registrations: { ok: 2, refused: 0, failed: 1 } }) }),
].join('\n')

const LOG_SA = [
  spawnRow('sa-ab-1', 'burndown', 200),
  spawnRow('sa-ab-2', 'burndown', 100),
  spawnRow('sa-ab-3', 'sa', 50),
  spawnRow('sa-ab-4', 'human', 40),
  spawnRow('sa-ab-5', 'shepherd', 30),
  spawnRow('sa-ab-0', 'burndown', 2 * 24 * 60),
  JSON.stringify({ ts: ago(45), agent: 'sa-ab-6', outcome: 'dispatched', note: 'seat row only' }),
].join('\n')

const ports = (over: Partial<DispatchStatsPorts> = {}): DispatchStatsPorts => ({
  now: NOW,
  seats: () => ['sb', 'sa'],
  tickRows: () => TICKS,
  ledger: () => LEDGER,
  dispatchLog: seat => (seat === 'sa' ? LOG_SA : undefined),
  journal: () => undefined,
  lastOkAt: () => ago(3),
  maxAgents: () => 20,
  verdicts: () => [],
  ...over,
})

const statsOf = (p: DispatchStatsPorts, seat: string): SeatDispatchStats | undefined =>
  dispatchStats(p, DAY_MS).find(s => s.seat === seat)

describe('burndown dispatch-stats', () => {
  it('prints every metric per seat from tick rows, the ledger and the dispatch log', () => {
    const report = dispatchStatsLines(ports(), '24h', false)

    expect(report.ok).toBe(true)
    const sa = report.lines.slice(report.lines.findIndex(l => l.startsWith('sa ')))
    expect(sa.slice(1, 10)).toEqual([
      '  spawns/h       tick 0.08 (2), hand 0.13 (3)',
      '  hand share     - (hand 0, tick 0, fix rounds 0)',
      '  queue          3 queued, age p50 30m, max 50m',
      '  ready depth    ready 2, unbriefed 5, stale 1',
      '  ready floor    2 of 2 ticks below 40, min 2, p50 2, longest 10m',
      '  cap use        implementers 2/3, reviewers 0/2, planners 1/1',
      `  refusals       out-of-scope 40, trust 7 (tick-summary ${ago(10)})`,
      '  registrations  ok 3, refused 1, failed 1',
      `  tick           last ${ago(10)} (tick-summary), dispatched no; last tick spawn ${ago(100)}`,
    ])
  })

  it('gives one JSON record per seat, in seat-name order', () => {
    const report = dispatchStatsLines(ports(), '24h', true)

    const records = report.lines.map(l => JSON.parse(l) as SeatDispatchStats)
    expect(records.map(r => r.seat)).toEqual(['sa', 'sb'])
    expect(records[0]?.spawns).toMatchObject({ tick: 2, hand: 3 })
    expect(records[1]).toMatchObject({
      queue: { depth: 1, p50Minutes: 5, maxMinutes: 5 },
      registrations: { ok: 1, refused: 1, failed: 0 },
      tick: { dispatched: null, source: 'tick-summary' },
    })
  })

  it("names the last row's trust refusals after the refusals line, text and JSON", () => {
    const named = [
      { initiative: 'claude-channels', task: 'CC-1026', reason: 'no accepted trust entry for dotfiles' },
    ]
    const p = ports({
      tickRows: () =>
        [
          row(20, { sa: summary({ trust: [{ initiative: 'x', task: 'X-1', reason: 'old' }] }) }),
          row(10, { sa: summary({ trust: named }) }),
        ].join('\n'),
    })

    const lines = dispatchStatsLines(p, '24h', false).lines
    const refusalsAt = lines.findIndex(l => l.startsWith('  refusals'))

    expect(lines[refusalsAt + 1]).toBe(
      '  trust          claude-channels CC-1026: no accepted trust entry for dotfiles',
    )
    expect(lines.filter(l => l.startsWith('  trust '))).toHaveLength(1)
    expect(statsOf(p, 'sa')?.trust).toEqual(named)
  })

  it('prints no trust line for a row without trust refusals and reads them as empty', () => {
    const lines = dispatchStatsLines(ports(), '24h', false).lines

    expect(lines.some(l => l.startsWith('  trust '))).toBe(false)
    expect(statsOf(ports(), 'sa')?.trust).toEqual([])
    expect(statsOf(ports({ tickRows: () => undefined }), 'sa')?.trust).toBeNull()
  })

  it('reports a dispatching tick and a skipped seat from the latest row that names them', () => {
    const p = ports({
      tickRows: () => row(5, { sa: summary({ dispatched: 2 }), sb: summary({ skipped: 'no plan' }) }),
    })

    expect(statsOf(p, 'sa')?.tick.dispatched).toBe(true)
    expect(statsOf(p, 'sb')?.tick).toMatchObject({ dispatched: false, skipped: 'no plan' })
  })

  it('falls back to the journal refusal line and the status file when no tick row is in the window', () => {
    const journal = [
      '08:00 burndown: dispatched nothing; refusals trust 3',
      '09:30 spawn AB-1 sa-ab-1 -',
      '11:05 burndown: dispatched nothing; full cap: 3 trees; refusals out-of-scope 990, trust 254, role-cap 2',
    ].join('\n')
    const p = ports({
      tickRows: () => undefined,
      journal: (seat, day) => (day.getDate() === 3 ? journal : undefined),
    })

    const sa = statsOf(p, 'sa')

    expect(sa?.refusals).toEqual({
      source: 'journal',
      at: new Date(2026, 1, 3, 11, 5).toISOString(),
      counts: { 'out-of-scope': 990, trust: 254, 'role-cap': 2 },
    })
    expect(sa?.tick).toEqual({ lastAt: ago(3), source: 'status', dispatched: null })
    expect(sa?.ready).toBeNull()
    expect(sa?.registrations).toEqual({ ok: 0, refused: 0, failed: 0 })
  })

  it('looks back across journal days but ignores a refusal line older than the window', () => {
    const old = '09:00 burndown: dispatched nothing; refusals trust 3'
    const yesterday = ports({
      tickRows: () => undefined,
      journal: (_, day) => (day.getDate() === 2 ? old : undefined),
    })
    const wider = dispatchStats(yesterday, 2 * DAY_MS).find(s => s.seat === 'sa')

    expect(statsOf(yesterday, 'sa')?.refusals).toBeNull()
    expect(wider?.refusals?.counts).toEqual({ trust: 3 })
  })

  it('shows dashes for a seat with no data at all', () => {
    const p = ports({
      tickRows: () => undefined,
      ledger: () => ({ version: 1, claims: [] }) as Ledger,
      lastOkAt: () => undefined,
    })

    const lines = dispatchStatsLines(p, '1h', false).lines

    expect(lines).toContain('  queue          0 queued, age p50 -m, max -m')
    expect(lines).toContain('  tick           last -, dispatched unknown; last tick spawn -')
  })

  it('refuses a --since that is not a window', () => {
    const report = dispatchStatsLines(ports(), 'yesterday', false)

    expect(report.ok).toBe(false)
    expect(report.errors?.[0]).toMatch(/--since yesterday is not a window/)
  })

  it('reads windows in minutes, hours and days', () => {
    expect([parseWindow('90m'), parseWindow('24h'), parseWindow('7d')]).toEqual([
      5_400_000, 86_400_000, 604_800_000,
    ])
    expect([parseWindow('0h'), parseWindow('5w'), parseWindow('')]).toEqual([undefined, undefined, undefined])
  })

  it('reads no refusal mix from a journal without a dispatched-nothing line', () => {
    expect(journalRefusals('09:00 spawn AB-1 sa-ab-1 -\n', NOW)).toBeUndefined()
  })
})

describe('burndown dispatch-stats implementer hand share (CC-965)', () => {
  const spawned = (agent: string, profile: string, spawner: string, minutesAgo = 10): string =>
    JSON.stringify({ ts: ago(minutesAgo), agent, agent_id: agent, outcome: 'dispatched', profile, spawner })

  const MIXED = [
    spawned('sa-ab-1', 'bd-implementer', 'burndown'),
    spawned('sa-ab-2', 'bd-implementer', 'burndown'),
    spawned('sa-ab-3', 'bd-implementer', 'sa'),
    spawned('sa-ab-4', 'bd-implementer', 'sa'),
    spawned('sa-ab-5', 'bd-implementer', 'human'),
    spawned('sa-ab-8-s1', 'bd-implementer', 'shepherd'),
    spawned('sa-ab-6', 'bd-planner', 'sa'),
    spawned('sa-ab-7', 'bd-implementer', 'sa', 2 * 24 * 60),
  ]
  const withLog = (lines: readonly string[]): DispatchStatsPorts =>
    ports({ dispatchLog: seat => (seat === 'sa' ? lines.join('\n') : undefined) })

  it('splits implementer spawns into tick and hand, sets fix rounds apart and leaves planners out', () => {
    const sa = statsOf(withLog(MIXED), 'sa')

    expect(sa?.spawns.implementers).toEqual({ tick: 2, hand: 3, fixRound: 1, handShare: 0.6 })
  })

  it('keeps fix rounds out of the hand share however many there are', () => {
    const rounds = Array.from({ length: 10 }, (_, i) => spawned(`sa-ab-${i + 10}-s1`, 'bd-implementer', 'sa'))

    const sa = statsOf(withLog([...MIXED, ...rounds]), 'sa')

    expect(sa?.spawns.implementers).toEqual({ tick: 2, hand: 3, fixRound: 11, handShare: 0.6 })
  })

  it('reads the hand share as null, not NaN, when the seat spawned no implementer', () => {
    const sa = statsOf(withLog([spawned('sa-ab-6', 'bd-planner', 'sa')]), 'sa')
    const json = JSON.parse(
      dispatchStatsLines(withLog([]), '24h', true).lines[0] ?? '{}',
    ) as SeatDispatchStats

    expect(sa?.spawns.implementers).toEqual({ tick: 0, hand: 0, fixRound: 0, handShare: null })
    expect(json.spawns.implementers.handShare).toBeNull()
  })

  it('prints a hand share line under the spawn rates', () => {
    const lines = dispatchStatsLines(withLog(MIXED), '24h', false).lines
    const spawnsAt = lines.findIndex(l => l.startsWith('  spawns/h'))

    expect(lines[spawnsAt + 1]).toBe('  hand share     0.6 (hand 3, tick 2, fix rounds 1)')
  })
})

describe('burndown dispatch-stats --by-brief-source', () => {
  const run = (task: string, minutesAgo: number, briefSource?: string): string =>
    JSON.stringify({
      ts: ago(minutesAgo),
      agent: `sa-${task.toLowerCase()}`,
      agent_id: `id-${task}`,
      task,
      outcome: 'dispatched',
      by: 'broker',
      spawner: 'burndown',
      ...(briefSource === undefined ? {} : { briefSource }),
    })

  const withRounds = (taskId: string, reviewRound?: number): Claim => ({
    ...claim(taskId, 'sa', 'implementing', 60),
    ...(reviewRound === undefined ? {} : { reviewRound }),
  })

  const verdict = (task: string, verdict: 'MERGE' | 'FIX_FIRST', head: string) => ({
    task,
    pr: 'o/r#1',
    head,
    verdict,
  })

  const fixture = (): DispatchStatsPorts =>
    ports({
      dispatchLog: seat =>
        seat === 'sa'
          ? [
              run('AB-1', 100, 'seat'),
              run('AB-2', 90, 'seat'),
              run('AB-3', 80, 'briefer'),
              run('AB-4', 70, 'template'),
              run('AB-5', 60),
              run('AB-6', 60, 'bogus'),
              run('AB-7', 3 * 24 * 60, 'seat'),
            ].join('\n')
          : undefined,
      ledger: () =>
        ({
          version: 1,
          claims: [
            withRounds('AB-1', 2),
            withRounds('AB-2', 1),
            withRounds('AB-3'),
            withRounds('AB-4', 3),
            withRounds('AB-5', 1),
            withRounds('AB-7', 9),
          ],
        }) as Ledger,
      verdicts: () => [
        verdict('AB-1', 'FIX_FIRST', 'a'),
        verdict('AB-2', 'FIX_FIRST', 'b'),
        verdict('AB-2', 'FIX_FIRST', 'c'),
        verdict('AB-2', 'MERGE', 'd'),
        verdict('AB-4', 'FIX_FIRST', 'e'),
        verdict('AB-5', 'FIX_FIRST', 'f'),
        verdict('AB-7', 'FIX_FIRST', 'g'),
      ],
    })

  it('counts fix rounds and FIX_FIRST verdicts per brief source, one JSON record each', () => {
    const report = dispatchStatsLines(fixture(), '24h', true, true)

    const records = report.lines.map(l => JSON.parse(l) as BriefSourceQuality)
    expect(
      records.map(({ source, tasks, fixRounds, fixFirst }) => [source, tasks, fixRounds, fixFirst]),
    ).toEqual([
      ['seat', 2, 3, 3],
      ['briefer', 1, 0, 0],
      ['template', 1, 3, 1],
      ['unknown', 2, 1, 1],
    ])
  })

  it('prints a line per source, and lists a source with no tasks as zeroes', () => {
    const lines = dispatchStatsLines(ports(), '24h', false, true).lines

    expect(lines).toEqual([
      'seat      tasks 0, fix rounds 0, FIX_FIRST 0',
      'briefer   tasks 0, fix rounds 0, FIX_FIRST 0',
      'template  tasks 0, fix rounds 0, FIX_FIRST 0',
      'unknown   tasks 0, fix rounds 0, FIX_FIRST 0',
    ])
  })

  it('reports an unreadable event log as a refusal', () => {
    const p = ports({
      verdicts: () => {
        throw new Error('events.db unreadable')
      },
    })

    expect(dispatchStatsLines(p, '24h', true, true).ok).toBe(false)
    expect(() => briefSourceQuality(p, DAY_MS)).toThrow('events.db unreadable')
  })
})

describe('ready floor', () => {
  const ticksAt = (ready: number[]): TickSummaryRow[] =>
    ready.map(
      (n, i) => JSON.parse(row((ready.length - i) * 10, { sa: summary({ ready: n }) })) as TickSummaryRow,
    )

  it('counts the ticks strictly under the floor, and not one at it', () => {
    const f = readyFloor(ticksAt([50, 39, 10, 45, 40]), 'sa', 40)

    expect(f).toMatchObject({ floor: 40, ticks: 5, below: 2, min: 10 })
  })

  it('counts none in a window held above the floor', () => {
    const f = readyFloor(ticksAt([40, 55, 41]), 'sa', 40)

    expect(f).toMatchObject({ below: 0, longestBelowMinutes: 0 })
  })

  it('measures the longest stretch in elapsed minutes, not rows', () => {
    const f = readyFloor(ticksAt([50, 5, 6, 7, 50, 1]), 'sa', 40)

    expect(f.longestBelowMinutes).toBe(20)
  })

  it('skips a row without the seat instead of counting it as zero', () => {
    const rows = [...ticksAt([50]), JSON.parse(row(5, { sb: summary() })) as TickSummaryRow]

    expect(readyFloor(rows, 'sa', 40)).toMatchObject({ ticks: 1, below: 0 })
  })

  it('takes the floor as twice the config maxAgents and reports it per seat', () => {
    const stats = statsOf(ports({ maxAgents: () => 3 }), 'sa')

    expect(stats?.readyFloor.floor).toBe(6)
  })

  it('lets an explicit floor win over maxAgents without reading the config', () => {
    const unread = ports({
      maxAgents: () => {
        throw new Error('config read')
      },
    })

    const stats = dispatchStats(unread, DAY_MS, 1).find(s => s.seat === 'sa')

    expect(stats?.readyFloor).toMatchObject({ floor: 1, below: 0 })
  })
})
