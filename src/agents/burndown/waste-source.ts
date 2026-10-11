import { parseVerdictBlock } from '@titan-design/session-read'
import type { DispatchRecord } from '../seats/dispatch-record.js'
import { openEvents } from '../seats/io.js'
import { shepherdTarget } from './shepherd.js'
import type { LineageObservation, VerdictObservation, WakeObservation } from './waste.js'

/**
 * CC-643 S2: events.db rows and dispatch runs as the observations waste.ts detects on, per the
 * CC-643 plan section 1. A pure read: events.db is opened read-only and nothing is written.
 */

/** A milestone task and the seat of its milestone. */
export interface WasteTask {
  task: string
  seat: string
}

export interface WasteInput {
  tasks: readonly WasteTask[]
  dispatches: readonly DispatchRecord[]
  /** Epoch ms, both ends inclusive. */
  window: { startMs: number; endMs: number }
}

export type TimedVerdict = VerdictObservation & { ts: number }

export interface WasteObservations {
  lineages: LineageObservation[]
  verdicts: TimedVerdict[]
  wakes: WakeObservation[]
  /** Per task, the event ids of its coordination messages, so a milestone counts each event once. */
  coordMessages: Record<string, number[]>
  /** Per task, its distinct merged PRs in the window, as lowercased `owner/repo#n`. */
  mergedPrs: Record<string, string[]>
}

export interface EventRow {
  id: number
  ts: number
  kind: string
  actor: string
  target: string | null
  body: string | null
}

const COORDINATION_KINDS = new Set(['message', 'notice', 'question', 'answer'])
const READ_KINDS = [...COORDINATION_KINDS, 'agent_resumed']
const BROKER = 'agent-chat'
const VERDICT_DEDUPE_MS = 60_000

/** A lineage's agents and PRs, read off its dispatch runs. */
interface Lineage extends WasteTask {
  agents: Set<string>
  prs: Set<string>
  merged: string[]
  hasImplementerRun: boolean
  namesTask: RegExp
}

const prKey = (pr: DispatchRecord['pr']): string | undefined => {
  const target = typeof pr === 'string' ? shepherdTarget(pr) : undefined
  return target === undefined ? undefined : `${target.repo}#${target.pr}`.toLowerCase()
}

const inWindow = (ts: number, w: WasteInput['window']): boolean => ts >= w.startMs && ts <= w.endMs

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function lineageOf(scope: WasteTask, input: WasteInput): Lineage {
  const runs = input.dispatches.filter(r => r.task === scope.task)
  const merged = runs.filter(
    r => r.outcome === 'merged' && r.ts !== null && inWindow(Date.parse(r.ts), input.window),
  )
  return {
    ...scope,
    agents: new Set(runs.flatMap(r => (r.agent_id === null ? [r.agent] : [r.agent, r.agent_id]))),
    prs: new Set(runs.flatMap(r => prKey(r.pr) ?? [])),
    merged: [...new Set(merged.flatMap(r => prKey(r.pr) ?? []))],
    hasImplementerRun: runs.some(r => r.profile !== null && /implementer/.test(r.profile)),
    namesTask: new RegExp(`(?<![\\w-])${escapeRegExp(scope.task)}(?![\\w-])`),
  }
}

const touches = (row: EventRow, names: ReadonlySet<string>): boolean =>
  names.has(row.actor) || (row.target !== null && names.has(row.target))

function isCoordination(row: EventRow, l: Lineage): boolean {
  if (!COORDINATION_KINDS.has(row.kind)) return false
  if (touches(row, l.agents)) return true
  return row.body !== null && l.namesTask.test(row.body) && touches(row, new Set([l.seat]))
}

const isWakeOf = (row: EventRow, agent: string): boolean =>
  row.target === agent && (row.kind === 'agent_resumed' || (row.kind === 'message' && row.actor === BROKER))

/** Each wake of `agent` in row order; rescued when the agent writes a message before its next wake. */
function wakesOf(rows: readonly EventRow[], agent: string, task: string): WakeObservation[] {
  const wakes: WakeObservation[] = []
  for (const row of rows) {
    if (isWakeOf(row, agent)) wakes.push({ task, agent, rescued: false })
    else if (row.kind === 'message' && row.actor === agent && wakes.length > 0)
      (wakes[wakes.length - 1] as WakeObservation).rescued = true
  }
  return wakes
}

function verdictOf(row: EventRow): Omit<TimedVerdict, 'task'> | undefined {
  if (row.kind !== 'message' || row.body === null) return undefined
  const block = parseVerdictBlock(row.body)
  if (!block.ok) return undefined
  return {
    pr: `${block.repo}#${block.pr}`.toLowerCase(),
    head: block.head,
    verdict: block.verdict,
    ts: row.ts,
  }
}

/** Verdicts on the lineages' PRs; a `(pr, head, verdict)` repeated within 60 s of the last one kept is a resend. */
function verdictsOn(rows: readonly EventRow[], lineages: readonly Lineage[]): TimedVerdict[] {
  const kept: TimedVerdict[] = []
  const lastAt = new Map<string, number>()
  for (const row of rows) {
    const v = verdictOf(row)
    const owner = v && lineages.find(l => l.prs.has(v.pr))
    if (v === undefined || owner === undefined) continue
    const key = `${v.pr}\u0000${v.head}\u0000${v.verdict}`
    const last = lastAt.get(key)
    if (last !== undefined && v.ts - last <= VERDICT_DEDUPE_MS) continue
    lastAt.set(key, v.ts)
    kept.push({ task: owner.task, ...v })
  }
  return kept
}

function lineageObservation(
  rows: readonly EventRow[],
  l: Lineage,
  coordMessages: number,
): LineageObservation {
  const resumes = rows.filter(
    row => row.kind === 'agent_resumed' && row.target !== null && l.agents.has(row.target),
  )
  return {
    task: l.task,
    transitions: coordMessages + resumes.length,
    mergedPrs: l.merged.length,
    hasImplementerRun: l.hasImplementerRun,
  }
}

/** The observations over rows already cut to the window and sorted by id. */
export function wasteObservations(rows: readonly EventRow[], input: WasteInput): WasteObservations {
  const lineages = input.tasks.map(scope => lineageOf(scope, input))
  const coordMessages = Object.fromEntries(
    lineages.map(l => [l.task, rows.filter(row => isCoordination(row, l)).map(row => row.id)]),
  )
  return {
    lineages: lineages.map(l => lineageObservation(rows, l, coordMessages[l.task]?.length ?? 0)),
    verdicts: verdictsOn(rows, lineages),
    wakes: lineages.flatMap(l => [...l.agents].flatMap(agent => wakesOf(rows, agent, l.task))),
    coordMessages,
    mergedPrs: Object.fromEntries(lineages.map(l => [l.task, l.merged])),
  }
}

function readWindowRows(dbPath: string, window: WasteInput['window']): EventRow[] {
  const db = openEvents(dbPath)
  try {
    const marks = READ_KINDS.map(() => '?').join(',')
    return db
      .prepare(
        `SELECT id, ts, kind, actor, target, body FROM events WHERE kind IN (${marks}) AND ts >= ? AND ts <= ? ORDER BY id`,
      )
      .all(...READ_KINDS, window.startMs, window.endMs) as unknown as EventRow[]
  } finally {
    db.close()
  }
}

/** The window's observations; an events.db that cannot be opened or read gives `{ error }`, never a throw. */
export function readWasteObservations(
  dbPath: string,
  input: WasteInput,
): WasteObservations | { error: string } {
  let rows: EventRow[]
  try {
    rows = readWindowRows(dbPath, input.window)
  } catch (err) {
    return { error: `events.db unreadable: ${err instanceof Error ? err.message : String(err)}` }
  }
  return wasteObservations(rows, input)
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/** A milestone's coordination messages and merged PRs, each counted once across its tasks. */
export function coordinationTotals(
  obs: Pick<WasteObservations, 'coordMessages' | 'mergedPrs'>,
  tasks: readonly string[],
): { coordMessages: number; mergedPrs: number; coordMessagesPerMergedPr: number | null } {
  const messages = new Set(tasks.flatMap(t => obs.coordMessages[t] ?? []))
  const prs = new Set(tasks.flatMap(t => obs.mergedPrs[t] ?? []))
  return {
    coordMessages: messages.size,
    mergedPrs: prs.size,
    coordMessagesPerMergedPr: prs.size > 0 ? round2(messages.size / prs.size) : null,
  }
}
