/**
 * CC-1661: the seat-watch eval join. Each coordinator turn a schedule or watcher started is matched
 * to the seat's newest shadow row at or before it; the gold label is whether that turn changed state.
 * Pure: the rows and turns arrive parsed. The turn shape is the workflows-2026-10-29 `turns.jsonl`.
 */

/** The triggers the gate replaces: fallback wakes, loop ticks, one-shot timers and Monitor completions. */
export const GATED_TRIGGERS: readonly string[] = [
  'fallback-wake',
  'loop-tick',
  'one-shot-timer',
  'bg-task-done',
]

/** Outcomes that changed nothing, when a turn carries no `state_change`. */
const NO_CHANGE = new Set(['nothing', 'log-only'])

/** A shadow row older than this says nothing about a turn: one 15-minute pass plus slack. */
export const MATCH_WINDOW_MS = 20 * 60_000

export interface ShadowRow {
  at: string
  seat: string
  decision: 'wake' | 'skip'
}

export interface Turn {
  seat: string
  ts: string
  trig: string
  outcome?: string
  usd?: number
  state_change?: boolean
}

export interface Matrix {
  tp: number
  fn: number
  fp: number
  tn: number
}

export interface JoinReport {
  matrix: Matrix
  /** TP / (TP + FN); null with no state-changing turn matched. */
  recall: number | null
  precision: number | null
  /** Turns the gate would have skipped, and their cost; `missedUsd` is the share that changed state. */
  avoided: { wakes: number; usd: number; missedUsd: number }
  matched: number
  /** Gated turns with no shadow row in the window before them. */
  unmatched: number
}

const changedState = (turn: Turn): boolean =>
  turn.state_change ?? (turn.outcome !== undefined && !NO_CHANGE.has(turn.outcome))

/** Each seat's rows, oldest first, as epoch ms. */
function bySeat(rows: readonly ShadowRow[]): Map<string, { at: number; decision: ShadowRow['decision'] }[]> {
  const seats = new Map<string, { at: number; decision: ShadowRow['decision'] }[]>()
  for (const row of rows) {
    const list = seats.get(row.seat) ?? []
    list.push({ at: Date.parse(row.at), decision: row.decision })
    seats.set(row.seat, list)
  }
  for (const list of seats.values()) list.sort((a, b) => a.at - b.at)
  return seats
}

function decisionAt(
  rows: readonly { at: number; decision: ShadowRow['decision'] }[] | undefined,
  atMs: number,
  windowMs: number,
): ShadowRow['decision'] | undefined {
  const before = (rows ?? []).filter(r => r.at <= atMs && atMs - r.at <= windowMs)
  return before[before.length - 1]?.decision
}

const ratio = (num: number, den: number): number | null => (den === 0 ? null : num / den)

export function joinShadow(
  rows: readonly ShadowRow[],
  turns: readonly Turn[],
  opts: { triggers?: readonly string[]; windowMs?: number } = {},
): JoinReport {
  const triggers = new Set(opts.triggers ?? GATED_TRIGGERS)
  const seats = bySeat(rows)
  const matrix: Matrix = { tp: 0, fn: 0, fp: 0, tn: 0 }
  const avoided = { wakes: 0, usd: 0, missedUsd: 0 }
  let unmatched = 0
  for (const turn of turns.filter(t => triggers.has(t.trig))) {
    const decision = decisionAt(seats.get(turn.seat), Date.parse(turn.ts), opts.windowMs ?? MATCH_WINDOW_MS)
    if (decision === undefined) {
      unmatched++
      continue
    }
    const gold = changedState(turn)
    matrix[decision === 'wake' ? (gold ? 'tp' : 'fp') : gold ? 'fn' : 'tn']++
    if (decision === 'skip') {
      avoided.wakes++
      avoided.usd += turn.usd ?? 0
      if (gold) avoided.missedUsd += turn.usd ?? 0
    }
  }
  const matched = matrix.tp + matrix.fn + matrix.fp + matrix.tn
  return {
    matrix,
    recall: ratio(matrix.tp, matrix.tp + matrix.fn),
    precision: ratio(matrix.tp, matrix.tp + matrix.fp),
    avoided,
    matched,
    unmatched,
  }
}

const pct = (v: number | null): string => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`)

export function renderJoin(report: JoinReport): string[] {
  const { matrix: m, avoided } = report
  return [
    `gated turns matched: ${report.matched}, unmatched: ${report.unmatched}`,
    '                 changed   no change',
    `  gate wake      TP ${String(m.tp).padStart(4)}   FP ${String(m.fp).padStart(4)}`,
    `  gate skip      FN ${String(m.fn).padStart(4)}   TN ${String(m.tn).padStart(4)}`,
    `recall on state-changing wakes: ${pct(report.recall)} (target 95%)`,
    `precision: ${pct(report.precision)}`,
    `wakes avoided: ${avoided.wakes}, $${avoided.usd.toFixed(2)} (of which $${avoided.missedUsd.toFixed(2)} on missed state changes)`,
  ]
}
