import { readInitiatives } from './source.js'
import { loadPolicy, seatScope } from './policy.js'
import { readScoredTasks } from './score-source.js'
import {
  dispatchOrder,
  scoreAll,
  type Components,
  type DispatchRow,
  type Exclusions,
  type ScoredTask,
  type ScoringDefaults,
} from './score.js'

/** CC-230: `burndown plan --seat --scored`, the seat's scored dispatch order with every component. CLI-only. */

export interface ScoredPlan {
  order: DispatchRow[]
  /** Initiatives in the seat's scope. */
  scope: number
  /** Open tasks read across that scope, excluded ones included. */
  open: number
  /** Exclusions from scoring, then share-cap skips from the dispatch order. */
  refused: Record<string, number>
  /** `<slug>/<file>` of each malformed open task the reader left out, so a low count from skips is not a real drop. */
  skipped: string[]
}

export interface ScoredPlanInputs {
  tasks: readonly ScoredTask[]
  weights: Readonly<Record<string, number>>
  defaults: ScoringDefaults
  exclusions: Exclusions
  hardStops: readonly string[]
  today: string
  top: number
  skipped?: readonly string[]
}

export function scoredPlan(input: ScoredPlanInputs): ScoredPlan {
  const { tasks, weights, defaults, exclusions, hardStops, today, top, skipped = [] } = input
  const scored = scoreAll(tasks, weights, defaults, exclusions, hardStops, today)
  const dispatched = dispatchOrder(scored.rows, defaults, top)
  return {
    order: dispatched.order,
    scope: Object.keys(weights).length,
    open: tasks.length,
    refused: { ...scored.refused, ...dispatched.refused },
    skipped: [...skipped],
  }
}

/** Reads the seat's policy from `autonomyRoot` and its scope's open tasks from the active-work root. */
export function scoredPlanFromDisk(opts: {
  seat: string
  top: number
  today: string
  autonomyRoot: string
  activeWorkRoot: string
}): ScoredPlan {
  const policy = loadPolicy(opts.autonomyRoot, opts.seat)
  const weights = seatScope(policy.charter, policy.seats, opts.seat, readInitiatives(opts.activeWorkRoot))
  const { tasks, skipped } = readScoredTasks(opts.activeWorkRoot, Object.keys(weights))
  return scoredPlan({
    tasks,
    skipped,
    weights,
    defaults: policy.defaults,
    exclusions: { tags: policy.seat.excluded_tags, titlePatterns: policy.seat.excluded_title_patterns },
    hardStops: policy.charter.hard_stops,
    today: opts.today,
    top: opts.top,
  })
}

const COMPONENT_KEYS: (keyof Components)[] = ['S', 'P', 'U', 'A', 'W', 'K', 'R', 'Z', 'H']
const TITLE_WIDTH = 90

const fixed = (x: number, width: number) => x.toFixed(1).padStart(width)

/** The first columns follow score.py's text output so the two diff by eye; components follow. */
export function renderScoredRow(row: DispatchRow, rank: number): string {
  const components = COMPONENT_KEYS.map(k => `${k}=${row.components[k].toFixed(2)}`).join(' ')
  const flags = row.stopShort.length > 0 ? ` stop-short:${row.stopShort.join(',')}` : ''
  return (
    `${String(rank).padStart(2)} ${fixed(row.effective, 5)} (${fixed(row.score, 5)}) ` +
    `${row.id.padEnd(9)} ${row.initiative.slice(0, 16).padEnd(16)} ${row.kind}/${row.kindSource}  ` +
    `${components} est=${row.estimate ?? '-'} route=${row.route}${flags} | ${row.title.slice(0, TITLE_WIDTH)}`
  )
}

export function renderScored(plan: ScoredPlan): string[] {
  const refused = Object.entries(plan.refused)
    .map(([kind, n]) => `${kind}: ${n}`)
    .join(', ')
  return [
    ...plan.order.map((row, i) => renderScoredRow(row, i + 1)),
    `scope=${plan.scope} initiatives, ${plan.open} open, skipped: ${plan.skipped.length}, refused={${refused}}`,
  ]
}
