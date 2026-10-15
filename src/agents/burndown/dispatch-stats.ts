import { foldDispatch, type DispatchRecord } from '../seats/dispatch-record.js'
import { SEAT_HAND_RESERVE, SEAT_SPAWN_OVERLAP, SEAT_SPAWN_UNPREFIXED } from '../seats/spawn-gate.js'
import { inferWorkRole } from '../spawn-provenance.js'
import type { Ledger } from './ledger.js'
import { NO_DISPATCH_PREFIX } from './no-dispatch.js'
import { orphanQueueLine, orphanQueues, type OrphanQueue } from './orphan-queue.js'
import { BRIEF_SOURCES, type BriefSource } from './task-tags.js'
import type { VerdictObservation } from './waste.js'
import {
  TICK_SUMMARY_VERSION,
  type NamedRefusal,
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
  /** The tick config's `maxAgents`; the ready floor is twice it unless `readyFloor` sets one. */
  maxAgents: () => number
  /** CC-1106: the tick config's `readyFloor`; absent or undefined keeps twice `maxAgents`. */
  readyFloor?: () => number | undefined
  /** CC-938: the review verdicts on the PRs of `runs`' tasks since `sinceMs`; throws when the event log cannot be read. */
  verdicts: (runs: readonly DispatchRecord[], sinceMs: number) => VerdictObservation[]
  /** CC-965: the seat spawn gate's warn and refuse rows since `sinceMs`, each attributed to a seat where one owns it. */
  gateRows: (sinceMs: number) => GateRows
}

export const GATE_CODES = [SEAT_HAND_RESERVE, SEAT_SPAWN_OVERLAP, SEAT_SPAWN_UNPREFIXED] as const
export type GateCode = (typeof GATE_CODES)[number]

export interface GateRow {
  seat?: string
  code: GateCode
  refused: boolean
  ts: number
}

export interface GateRows {
  rows: GateRow[]
  /** True when the stores do not reach back to the window's start, so the counts may be short. */
  partial: boolean
}

export interface GateCounts {
  reserveWarn: number
  reserveRefused: number
  overlapWarn: number
  overlapRefused: number
  unprefixedWarn: number
  unprefixedRefused: number
  partial: boolean
}

export interface RefusalMix {
  source: 'tick-summary' | 'journal'
  at: string
  counts: Record<string, number>
}

/** CC-967: ready depth over the window against the floor; `below` counts ticks strictly under it. */
export interface ReadyFloor {
  floor: number
  ticks: number
  below: number
  min: number | null
  p50: number | null
  longestBelowMinutes: number
}

/** CC-965: implementer spawns split by spawner; fix rounds are counted apart and stay out of `handShare`. */
export interface ImplementerCounts {
  tick: number
  hand: number
  fixRound: number
  /** `hand / (tick + hand)`, to two places; null when the seat spawned no implementer. */
  handShare: number | null
}

export interface SeatDispatchStats {
  seat: string
  since: string
  spawns: {
    tick: number
    hand: number
    tickPerHour: number
    handPerHour: number
    lastTickAt: string | null
    implementers: ImplementerCounts
  }
  queue: { depth: number; p50Minutes: number | null; maxMinutes: number | null }
  /** CC-1226: set when the seat holds queued claims but the window's last tick planned nothing for it. */
  orphan: OrphanQueue | null
  ready: Pick<SeatSummary, 'ready' | 'unbriefed' | 'stale'> | null
  readyFloor: ReadyFloor
  caps: SeatSummary['roles'] | null
  refusals: RefusalMix | null
  trust: NamedRefusal[] | null
  registrations: RegisterCounts
  gate: GateCounts
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

const round2 = (n: number): number => Math.round(n * 100) / 100

/** The window's implementer spawns, tick against hand as `spawnCounts` splits them, fix rounds set apart. */
export function implementerCounts(log: string | undefined, sinceMs: number): ImplementerCounts {
  const counts = { tick: 0, hand: 0, fixRound: 0 }
  for (const r of foldDispatch(log ?? '').records) {
    if (r.spawner === null || r.ts === null || Date.parse(r.ts) < sinceMs) continue
    const role = inferWorkRole(r.profile ?? '', r.agent)
    if (role.startsWith('fix-round-')) counts.fixRound += 1
    else if (role === 'implementer') counts[r.spawner === 'burndown' ? 'tick' : 'hand'] += 1
  }
  const total = counts.tick + counts.hand
  return { ...counts, handShare: total === 0 ? null : round2(counts.hand / total) }
}

const GATE_KEYS: Record<GateCode, 'reserve' | 'overlap' | 'unprefixed'> = {
  [SEAT_HAND_RESERVE]: 'reserve',
  [SEAT_SPAWN_OVERLAP]: 'overlap',
  [SEAT_SPAWN_UNPREFIXED]: 'unprefixed',
}

/** The seat's gate rows, warns apart from refusals. */
export function gateCounts({ rows, partial }: GateRows, seat: string): GateCounts {
  const counts: GateCounts = {
    reserveWarn: 0,
    reserveRefused: 0,
    overlapWarn: 0,
    overlapRefused: 0,
    unprefixedWarn: 0,
    unprefixedRefused: 0,
    partial,
  }
  for (const row of rows) {
    if (row.seat === seat) counts[`${GATE_KEYS[row.code]}${row.refused ? 'Refused' : 'Warn'}`] += 1
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

/** The seat's ready depth over `rows` against `floor`; a row without the seat is not a tick of it. */
export function readyFloor(rows: readonly TickSummaryRow[], seat: string, floor: number): ReadyFloor {
  const ticks = rows.flatMap(r =>
    r.seats[seat] === undefined ? [] : [{ at: Date.parse(r.ts), ready: r.seats[seat].ready }],
  )
  const depths = ticks.map(t => t.ready).sort((a, b) => a - b)
  let below = 0
  let longestMs = 0
  let runStart: number | undefined
  for (const t of ticks) {
    if (t.ready >= floor) {
      runStart = undefined
      continue
    }
    below += 1
    runStart ??= t.at
    longestMs = Math.max(longestMs, t.at - runStart)
  }
  return {
    floor,
    ticks: ticks.length,
    below,
    min: depths[0] ?? null,
    p50: depths[Math.floor((depths.length - 1) / 2)] ?? null,
    longestBelowMinutes: Math.round(longestMs / MINUTE_MS),
  }
}

/** The seat's queue as an orphan: no plan for it in the last tick row, or no tick row in the window at all. */
function orphanOf(w: Window, seat: string, now: Date): OrphanQueue | null {
  const planned = Object.entries(w.rows.at(-1)?.seats ?? {}).filter(([, s]) => s.skipped === undefined)
  const found = orphanQueues(w.ledger, new Set(planned.map(([name]) => name)), now)
  return found.find(o => o.seat === seat) ?? null
}

const perHour = (n: number, windowMs: number): number => round2(n / (windowMs / HOUR_MS))

interface Window {
  sinceMs: number
  windowMs: number
  rows: readonly TickSummaryRow[]
  ledger: Ledger
  floor: number
  gate: GateRows
}

function seatStats(ports: DispatchStatsPorts, seat: string, w: Window): SeatDispatchStats {
  const log = ports.dispatchLog(seat)
  const spawns = spawnCounts(log, w.sinceMs)
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
      implementers: implementerCounts(log, w.sinceMs),
    },
    queue: queueAges(w.ledger, seat, ports.now),
    orphan: orphanOf(w, seat, ports.now),
    ready:
      summary === undefined
        ? null
        : { ready: summary.ready, unbriefed: summary.unbriefed, stale: summary.stale },
    readyFloor: readyFloor(w.rows, seat, w.floor),
    caps: summary?.roles ?? null,
    refusals: fromRow ?? latestJournalRefusals(ports, seat, w.sinceMs),
    trust: summary === undefined ? null : (summary.trust ?? []),
    registrations: sumRegistrations(w.rows, seat),
    gate: gateCounts(w.gate, seat),
    tick: tickHealth(ports, last, seat),
  }
}

/** CC-967: the ready depth a seat should hold, the configured floor or twice `maxAgents`; CC-986 plans below it. */
export const readyFloorFor = (maxAgents: number, configured?: number): number => configured ?? 2 * maxAgents

/** One record per seat, in seat-name order. `floor` overrides the config's ready floor. */
export function dispatchStats(
  ports: DispatchStatsPorts,
  windowMs: number,
  floor?: number,
): SeatDispatchStats[] {
  const sinceMs = ports.now.getTime() - windowMs
  const w: Window = {
    sinceMs,
    windowMs,
    rows: tickRowsSince(ports.tickRows(), sinceMs),
    ledger: ports.ledger(),
    floor: floor ?? readyFloorFor(ports.maxAgents(), ports.readyFloor?.()),
    gate: ports.gateRows(sinceMs),
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

const trustLine = (t: NamedRefusal): string =>
  `${t.initiative}${t.task === undefined ? '' : ` ${t.task}`}: ${t.reason}`

function floorLine(f: ReadyFloor): string {
  return `${f.below} of ${f.ticks} ticks below ${f.floor}, min ${dash(f.min)}, p50 ${dash(f.p50)}, longest ${f.longestBelowMinutes}m`
}

function handShareLine({ tick, hand, fixRound, handShare }: ImplementerCounts): string {
  return `${dash(handShare)} (hand ${hand}, tick ${tick}, fix rounds ${fixRound})`
}

function gateLine(g: GateCounts): string {
  const pair = (name: string, warn: number, refused: number): string =>
    `${name} warn ${warn} refused ${refused}`
  return (
    [
      pair('reserve', g.reserveWarn, g.reserveRefused),
      pair('overlap', g.overlapWarn, g.overlapRefused),
      pair('unprefixed', g.unprefixedWarn, g.unprefixedRefused),
    ].join(', ') + (g.partial ? ' (partial window)' : '')
  )
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
      `  hand share     ${handShareLine(spawns.implementers)}`,
      `  spawn gate     ${gateLine(s.gate)}`,
      `  queue          ${queue.depth} queued, age p50 ${dash(queue.p50Minutes)}m, max ${dash(queue.maxMinutes)}m`,
      ...(s.orphan === null ? [] : [`  ${orphanQueueLine(s.orphan)}`]),
      `  ready depth    ${ready === null ? '-' : `ready ${ready.ready}, unbriefed ${ready.unbriefed}, stale ${ready.stale}`}`,
      `  ready floor    ${floorLine(s.readyFloor)}`,
      `  cap use        ${capsLine(s.caps)}`,
      `  refusals       ${refusalsLine(s.refusals)}`,
      ...(s.trust ?? []).map(t => `  trust          ${trustLine(t)}`),
      `  registrations  ok ${reg.ok}, refused ${reg.refused}, failed ${reg.failed}`,
      `  tick           ${tickLine(s)}`,
    ]
  })
}

/** CC-938 (item 179 S14): review churn on the tasks whose brief came from one source. */
export interface BriefSourceQuality {
  source: BriefSource
  since: string
  /** Distinct tasks with a dispatch in the window. */
  tasks: number
  /** Summed `reviewRound` over those tasks' claims. */
  fixRounds: number
  fixFirst: number
}

const SOURCES: readonly BriefSource[] = [...BRIEF_SOURCES, 'unknown']

/** A task's source is its earliest dispatch row's; a row from before CC-953 reads as `unknown`. */
function sourcesByTask(runs: readonly DispatchRecord[]): Map<string, BriefSource> {
  const byTask = new Map<string, BriefSource>()
  const ordered = runs.toSorted((a, b) => Date.parse(a.ts ?? '') - Date.parse(b.ts ?? ''))
  for (const r of ordered) {
    if (r.task !== null && !byTask.has(r.task)) byTask.set(r.task, r.briefSource ?? 'unknown')
  }
  return byTask
}

/** One record per brief source, in `seat, briefer, template, unknown` order, over every seat's dispatches in the window. */
export function briefSourceQuality(ports: DispatchStatsPorts, windowMs: number): BriefSourceQuality[] {
  const sinceMs = ports.now.getTime() - windowMs
  const runs = ports
    .seats()
    .flatMap(seat => foldDispatch(ports.dispatchLog(seat) ?? '').records)
    .filter(r => r.ts !== null && Date.parse(r.ts) >= sinceMs)
  const sourceOf = sourcesByTask(runs)
  const rounds = new Map<string, number>()
  for (const c of ports.ledger().claims)
    rounds.set(c.taskId, (rounds.get(c.taskId) ?? 0) + (c.reviewRound ?? 0))
  const fixFirst = new Map<string, number>()
  for (const v of ports.verdicts(runs, sinceMs)) {
    if (v.verdict === 'FIX_FIRST') fixFirst.set(v.task, (fixFirst.get(v.task) ?? 0) + 1)
  }
  return SOURCES.map(source => {
    const tasks = [...sourceOf].filter(([, s]) => s === source).map(([task]) => task)
    const total = (by: Map<string, number>): number => tasks.reduce((n, t) => n + (by.get(t) ?? 0), 0)
    return {
      source,
      since: new Date(sinceMs).toISOString(),
      tasks: tasks.length,
      fixRounds: total(rounds),
      fixFirst: total(fixFirst),
    }
  })
}

/** The text form: one line per source. */
export function renderBriefSourceQuality(rows: readonly BriefSourceQuality[]): string[] {
  return rows.map(
    r => `${r.source.padEnd(9)} tasks ${r.tasks}, fix rounds ${r.fixRounds}, FIX_FIRST ${r.fixFirst}`,
  )
}
