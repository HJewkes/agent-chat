/**
 * CC-1111: how long a slot freed by a burndown agent's exit waits for the tick to dispatch into it. Each exit,
 * oldest first, takes one unit of dispatch from the earliest `burndown-ticks.jsonl` row at or after it that has
 * one left. A row's `ts` is its tick's start, so the wait is the delay before that tick began; the tick's own
 * planning time is not in it. An exit with no dispatch within `maxWaitMs` is unmatched: the slot sat idle for
 * want of ready work, which no tick cadence fixes, so it stays out of the median.
 */

export interface AgentExit {
  agentId: string
  atMs: number
}

export interface DispatchTick {
  atMs: number
  dispatched: number
}

export interface ExitLatency {
  samples: number
  unmatched: number
  medianMs: number | undefined
}

export const DEFAULT_MAX_WAIT_MS = 30 * 60_000

/** v1 rows with any dispatch, summed across seats; other versions and unparsable lines are skipped. */
export function dispatchTicks(text: string): DispatchTick[] {
  const ticks: DispatchTick[] = []
  for (const line of text.split('\n')) {
    const row = parseRow(line)
    if (row === undefined) continue
    const dispatched = Object.values(row.seats ?? {}).reduce((n, s) => n + (s?.dispatched ?? 0), 0)
    const atMs = Date.parse(row.ts ?? '')
    if (dispatched > 0 && Number.isFinite(atMs)) ticks.push({ atMs, dispatched })
  }
  return ticks.sort((a, b) => a.atMs - b.atMs)
}

interface RawRow {
  v?: unknown
  ts?: string
  seats?: Record<string, { dispatched?: number } | undefined>
}

function parseRow(line: string): RawRow | undefined {
  if (line.trim() === '') return undefined
  try {
    const row = JSON.parse(line) as RawRow
    return row.v === 1 ? row : undefined
  } catch {
    return undefined
  }
}

/** An agent that both exits and is retired counts once, at its first row. */
export function firstExits(exits: readonly AgentExit[]): AgentExit[] {
  const first = new Map<string, AgentExit>()
  for (const exit of exits) {
    const seen = first.get(exit.agentId)
    if (seen === undefined || exit.atMs < seen.atMs) first.set(exit.agentId, exit)
  }
  return [...first.values()].sort((a, b) => a.atMs - b.atMs)
}

export function exitToDispatch(
  exits: readonly AgentExit[],
  ticks: readonly DispatchTick[],
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
): ExitLatency {
  const left = ticks.map(t => ({ ...t }))
  const waits: number[] = []
  let unmatched = 0
  for (const exit of firstExits(exits)) {
    const tick = left.find(t => t.atMs >= exit.atMs && t.dispatched > 0)
    if (tick === undefined || tick.atMs - exit.atMs > maxWaitMs) {
      unmatched += 1
      continue
    }
    tick.dispatched -= 1
    waits.push(tick.atMs - exit.atMs)
  }
  return { samples: waits.length, unmatched, medianMs: median(waits) }
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}
