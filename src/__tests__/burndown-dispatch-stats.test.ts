import { describe, expect, it } from 'vitest'
import {
  dispatchStats,
  journalRefusals,
  parseWindow,
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
  ...over,
})

const statsOf = (p: DispatchStatsPorts, seat: string): SeatDispatchStats | undefined =>
  dispatchStats(p, DAY_MS).find(s => s.seat === seat)

describe('burndown dispatch-stats', () => {
  it('prints every metric per seat from tick rows, the ledger and the dispatch log', () => {
    const report = dispatchStatsLines(ports(), '24h', false)

    expect(report.ok).toBe(true)
    const sa = report.lines.slice(report.lines.findIndex(l => l.startsWith('sa ')))
    expect(sa.slice(1, 8)).toEqual([
      '  spawns/h       tick 0.08 (2), hand 0.13 (3)',
      '  queue          3 queued, age p50 30m, max 50m',
      '  ready depth    ready 2, unbriefed 5, stale 1',
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
