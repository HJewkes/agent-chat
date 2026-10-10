import { foldDispatch } from '../seats/dispatch-record.js'
import type { Ledger } from './ledger.js'
import { NO_DISPATCH_PREFIX } from './no-dispatch.js'
import {
  TICK_SUMMARY_VERSION,
  type RegisterCounts,
  type SeatSummary,
  type TickSummaryRow,
} from './tick-summary.js'

/**
 * CC-933 (item 179 S9): one seat's dispatch health over a window, read from stores the tick and the broker
 * already write: the CC-929 tick rows, the claim ledger, the seat's dispatch log and its journal. Pure over
 * `DispatchStatsPorts`; `dispatch-stats-source.ts` binds them to disk.
 */

export interface DispatchStatsPorts {
  now: Date
  seats: () => string[]
  /** `burndown-ticks.jsonl`'s text; undefined when there is none yet. */
  tickRows: () => string | undefined
  ledger: () => Ledger
  dispatchLog: (seat: string) => string | undefined
  /** The seat's journal for the local day holding `day`. */
  journal: (seat: string, day: Date) => string | undefined
  /** The tick status file's last good tick, the fallback when no tick row is in the window. */
  lastOkAt: () => string | undefined
}

export interface RefusalMix {
  source: 'tick-summary' | 'journal'
  at: string
  counts: Record<string, number>
}

export interface SeatDispatchStats {
  seat: string
  since: string
  spawns: { tick: number; hand: number; tickPerHour: number; handPerHour: number; lastTickAt: string | null }
  queue: { depth: number; p50Minutes: number | null; maxMinutes: number | null }
  ready: Pick<SeatSummary, 'ready' | 'unbriefed' | 'stale'> | null
  caps: SeatSummary['roles'] | null
  refusals: RefusalMix | null
  registrations: RegisterCounts
  tick: {
    lastAt: string | null
    source: 'tick-summary' | 'status' | null
    dispatched: boolean | null
    skipped?: string
  }
}

const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000
const UNIT_MS: Record<string, number> = { m: MINUTE_MS, h: HOUR_MS, d: 24 * HOUR_MS }

export const DEFAULT_WINDOW = '24h'

/** A `--since` window such as `90m`, `24h` or `7d`, in ms; undefined when it is not one. */
export function parseWindow(value: string): number | undefined {
  const m = /^(\d+)([mhd])$/.exec(value.trim())
  if (m === null) return undefined
  const ms = Number(m[1]) * (UNIT_MS[m[2] ?? ''] ?? 0)
  return ms > 0 ? ms : undefined
}

function isTickRow(value: unknown): value is TickSummaryRow {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Partial<TickSummaryRow>
  return row.v === TICK_SUMMARY_VERSION && typeof row.ts === 'string' && typeof row.seats === 'object'
}

/** Rows at or after `sinceMs`, oldest first; a malformed line or an unknown `v` is skipped, as CC-929 asks. */
export function tickRowsSince(text: string | undefined, sinceMs: number): TickSummaryRow[] {
  const rows: TickSummaryRow[] = []
  for (const line of (text ?? '').split('\n')) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (isTickRow(parsed) && Date.parse(parsed.ts) >= sinceMs) rows.push(parsed)
  }
  return rows.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
}

/** The broker's spawn rows in the window: `spawner: burndown` is the tick's, any other spawner a hand spawn. */
export function spawnCounts(
  log: string | undefined,
  sinceMs: number,
): { tick: number; hand: number; lastTickAt: string | null } {
  const counts = { tick: 0, hand: 0, lastTickAt: null as string | null }
  for (const r of foldDispatch(log ?? '').records) {
    if (r.spawner === null || r.ts === null || Date.parse(r.ts) < sinceMs) continue
    if (r.spawner !== 'burndown') counts.hand += 1
    else {
      counts.tick += 1
      if (counts.lastTickAt === null || Date.parse(r.ts) > Date.parse(counts.lastTickAt))
        counts.lastTickAt = r.ts
    }
  }
  return counts
}

/** The seat's `queued` claims, aged from when they entered the queue. */
export function queueAges(ledger: Ledger, seat: string, now: Date): SeatDispatchStats['queue'] {
  const ages = ledger.claims
    .filter(c => c.seat === seat && c.phase === 'queued')
    .map(c => Math.max(0, Math.round((now.getTime() - Date.parse(c.phaseAt)) / MINUTE_MS)))
    .filter(age => Number.isFinite(age))
    .sort((a, b) => a - b)
  const p50 = ages[Math.floor((ages.length - 1) / 2)]
  return { depth: ages.length, p50Minutes: p50 ?? null, maxMinutes: ages.at(-1) ?? null }
}

const NO_DISPATCH_LINE = new RegExp(`^(\\d\\d):(\\d\\d) ${NO_DISPATCH_PREFIX}.*; refusals (.+)$`)

function refusalCounts(listed: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const part of listed.split(', ')) {
    const m = /^(\S+) (\d+)$/.exec(part.trim())
    if (m !== null) counts[m[1] ?? ''] = Number(m[2])
  }
  return counts
}

/** The last `burndown: dispatched nothing` line with refusal counts in one day's journal. */
export function journalRefusals(text: string | undefined, day: Date): RefusalMix | undefined {
  const line = (text ?? '')
    .split('\n')
    .map(l => NO_DISPATCH_LINE.exec(l))
    .findLast(m => m !== null)
  if (line === undefined || line === null) return undefined
  const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(line[1]), Number(line[2]))
  return { source: 'journal', at: at.toISOString(), counts: refusalCounts(line[3] ?? '') }
}

/** Local days from the one holding `sinceMs` to today, newest first. */
function windowDays(sinceMs: number, now: Date): Date[] {
  const noon = (d: Date, back = 0): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() - back, 12)
  const first = noon(new Date(sinceMs))
  const days: Date[] = []
  for (let d = noon(now); d.getTime() >= first.getTime(); d = noon(d, 1)) days.push(d)
  return days
}

function latestJournalRefusals(ports: DispatchStatsPorts, seat: string, sinceMs: number): RefusalMix | null {
  for (const day of windowDays(sinceMs, ports.now)) {
    const mix = journalRefusals(ports.journal(seat, day), day)
    if (mix !== undefined) return Date.parse(mix.at) >= sinceMs ? mix : null
  }
  return null
}

function sumRegistrations(rows: readonly TickSummaryRow[], seat: string): RegisterCounts {
  const total = { ok: 0, refused: 0, failed: 0 }
  for (const row of rows) {
    const r = row.seats[seat]?.registrations
    if (r === undefined) continue
    total.ok += r.ok
    total.refused += r.refused
    total.failed += r.failed
  }
  return total
}

function tickHealth(
  ports: DispatchStatsPorts,
  last: TickSummaryRow | undefined,
  seat: string,
): SeatDispatchStats['tick'] {
  if (last === undefined) {
    const at = ports.lastOkAt()
    return { lastAt: at ?? null, source: at === undefined ? null : 'status', dispatched: null }
  }
  const summary = last.seats[seat]
  return {
    lastAt: last.ts,
    source: 'tick-summary',
    dispatched: summary === undefined ? null : summary.dispatched > 0,
    ...(summary?.skipped === undefined ? {} : { skipped: summary.skipped }),
  }
}

const perHour = (n: number, windowMs: number): number => Math.round((n / (windowMs / HOUR_MS)) * 100) / 100

interface Window {
  sinceMs: number
  windowMs: number
  rows: readonly TickSummaryRow[]
  ledger: Ledger
}

function seatStats(ports: DispatchStatsPorts, seat: string, w: Window): SeatDispatchStats {
  const spawns = spawnCounts(ports.dispatchLog(seat), w.sinceMs)
  const last = w.rows.at(-1)
  const summary = last?.seats[seat]
  const fromRow: RefusalMix | undefined =
    summary === undefined || last === undefined
      ? undefined
      : { source: 'tick-summary', at: last.ts, counts: summary.refusals }
  return {
    seat,
    since: new Date(w.sinceMs).toISOString(),
    spawns: {
      ...spawns,
      tickPerHour: perHour(spawns.tick, w.windowMs),
      handPerHour: perHour(spawns.hand, w.windowMs),
    },
    queue: queueAges(w.ledger, seat, ports.now),
    ready:
      summary === undefined
        ? null
        : { ready: summary.ready, unbriefed: summary.unbriefed, stale: summary.stale },
    caps: summary?.roles ?? null,
    refusals: fromRow ?? latestJournalRefusals(ports, seat, w.sinceMs),
    registrations: sumRegistrations(w.rows, seat),
    tick: tickHealth(ports, last, seat),
  }
}

/** One record per seat, in seat-name order. */
export function dispatchStats(ports: DispatchStatsPorts, windowMs: number): SeatDispatchStats[] {
  const sinceMs = ports.now.getTime() - windowMs
  const w: Window = {
    sinceMs,
    windowMs,
    rows: tickRowsSince(ports.tickRows(), sinceMs),
    ledger: ports.ledger(),
  }
  return [...ports.seats()].sort().map(seat => seatStats(ports, seat, w))
}

const dash = (v: number | string | null | undefined): string =>
  v === null || v === undefined ? '-' : String(v)

function capsLine(caps: SeatDispatchStats['caps']): string {
  if (caps === null || caps === undefined) return '-'
  const roles = ['implementers', 'reviewers', 'planners'] as const
  return roles.map(r => `${r} ${caps.used[r]}/${caps.cap[r]}`).join(', ')
}

function refusalsLine(mix: RefusalMix | null): string {
  if (mix === null) return '-'
  const sorted = Object.entries(mix.counts).sort(([a, m], [b, n]) => n - m || a.localeCompare(b))
  const listed = sorted.length === 0 ? 'none' : sorted.map(([kind, n]) => `${kind} ${n}`).join(', ')
  return `${listed} (${mix.source} ${mix.at})`
}

function tickLine({ tick, spawns }: SeatDispatchStats): string {
  const dispatched = tick.dispatched === null ? 'unknown' : tick.dispatched ? 'yes' : 'no'
  const skipped = tick.skipped === undefined ? '' : `, skipped: ${tick.skipped}`
  const source = tick.source === null ? '' : ` (${tick.source})`
  return `last ${dash(tick.lastAt)}${source}, dispatched ${dispatched}${skipped}; last tick spawn ${dash(spawns.lastTickAt)}`
}

/** The text form: a block per seat, one metric per line. */
export function renderDispatchStats(stats: readonly SeatDispatchStats[]): string[] {
  return stats.flatMap(s => {
    const { spawns, queue, ready, registrations: reg } = s
    return [
      `${s.seat} (since ${s.since})`,
      `  spawns/h       tick ${spawns.tickPerHour} (${spawns.tick}), hand ${spawns.handPerHour} (${spawns.hand})`,
      `  queue          ${queue.depth} queued, age p50 ${dash(queue.p50Minutes)}m, max ${dash(queue.maxMinutes)}m`,
      `  ready depth    ${ready === null ? '-' : `ready ${ready.ready}, unbriefed ${ready.unbriefed}, stale ${ready.stale}`}`,
      `  cap use        ${capsLine(s.caps)}`,
      `  refusals       ${refusalsLine(s.refusals)}`,
      `  registrations  ok ${reg.ok}, refused ${reg.refused}, failed ${reg.failed}`,
      `  tick           ${tickLine(s)}`,
    ]
  })
}
