import { describe, expect, it } from 'vitest'
import type { Claim, Ledger } from '../agents/burndown/ledger.js'
import { orphanQueueLine, orphanQueues } from '../agents/burndown/orphan-queue.js'
import {
  dispatchStats,
  renderDispatchStats,
  type DispatchStatsPorts,
} from '../agents/burndown/dispatch-stats.js'
import { tickSummary, type SeatSummary } from '../agents/burndown/tick-summary.js'

/** CC-1226 (D19): a seat that holds queued claims but is not ticked is flagged, not silent. */

const NOW = new Date(2026, 9, 12, 12, 0)
const ago = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString()

const claim = (taskId: string, seat: string, minutesAgo: number, extra: Partial<Claim> = {}): Claim => ({
  taskId,
  initiative: 'demo',
  spawnedAt: ago(minutesAgo),
  phase: 'queued',
  phaseAt: ago(minutesAgo),
  seat,
  ...extra,
})

const ledger = (claims: Claim[]): Ledger => ({ claims }) as Ledger

const queued = ledger([
  claim('D-1', 'seat-b', 90),
  claim('D-2', 'seat-b', 30, { slice: 'b', dependsOn: ['a'] }),
  claim('T-1', 'seat-a', 500),
])

describe('orphanQueues', () => {
  it('flags a seat with queued claims that no plan covers this tick, and counts its ready slices', () => {
    const found = orphanQueues(queued, new Set(['seat-a']), NOW)

    expect(found).toEqual([{ seat: 'seat-b', queued: 2, ready: 1, oldestMinutes: 90 }])
    expect(found.map(orphanQueueLine)).toEqual([
      'orphan queue: seat seat-b not ticked, 2 queued (1 ready), oldest 90m',
    ])
  })

  it('stays silent for a ticked seat and for a seat with nothing queued', () => {
    const l = ledger([claim('D-1', 'seat-b', 5, { phase: 'implementing' })])

    expect(orphanQueues(queued, new Set(['seat-a', 'seat-b']), NOW)).toEqual([])
    expect(orphanQueues(l, new Set(['seat-a']), NOW)).toEqual([])
  })
})

const seatRow = (extra: Partial<SeatSummary> = {}): SeatSummary => ({
  ready: 0,
  unbriefed: 0,
  stale: 0,
  dispatched: 0,
  refusals: {},
  registrations: { ok: 0, refused: 0, failed: 0 },
  ...extra,
})

describe('tick summary row', () => {
  it('carries the orphan queue when only seat-a is planned', () => {
    const row = tickSummary({
      now: NOW,
      maxAgeDays: 7,
      caps: {},
      dispatch: [],
      tasks: new Map(),
      registrations: [],
      outcomes: [{ seat: 'seat-a', dispatched: 0, refusals: [] }],
      ledger: queued,
    })

    expect(row.orphanQueues).toEqual([{ seat: 'seat-b', queued: 2, ready: 1, oldestMinutes: 90 }])
  })
})

describe('dispatch-stats', () => {
  const tickRow = JSON.stringify({
    v: 1,
    ts: ago(5),
    registrations: { ok: 0, refused: 0, failed: 0 },
    seats: { 'seat-a': seatRow() },
  })
  const ports: DispatchStatsPorts = {
    now: NOW,
    seats: () => ['seat-b', 'seat-a'],
    tickRows: () => tickRow,
    ledger: () => queued,
    dispatchLog: () => undefined,
    journal: () => undefined,
    lastOkAt: () => undefined,
    maxAgents: () => 3,
    verdicts: () => [],
    gateRows: () => ({ rows: [], partial: false }),
  }

  it('prints the orphan queue line under the unticked seat only', () => {
    const lines = renderDispatchStats(dispatchStats(ports, 24 * 3_600_000))

    const flagged = lines.filter(l => l.includes('orphan queue'))
    expect(flagged).toEqual(['  orphan queue: seat seat-b not ticked, 2 queued (1 ready), oldest 90m'])
  })
})
