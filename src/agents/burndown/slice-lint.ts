import type { PlannedSlice } from './report.js'

/**
 * CC-631: the planning-phase lint over a planner's slices. Each failing slice and
 * rule gives one reason line naming the slice, so a stalled planner says what to fix.
 * The design's parent-epic-in-milestone rule is not here: the planning phase has no
 * milestone data.
 */

export const MAX_SLICE_POINTS = 3

type Rule = (slice: PlannedSlice, names: ReadonlySet<string>) => string[]

const RULES: Rule[] = [
  s => (s.points === undefined ? [`slice ${s.n}: no points`] : []),
  s =>
    s.points !== undefined && s.points > MAX_SLICE_POINTS
      ? [`slice ${s.n}: ${s.points} points, over the ${MAX_SLICE_POINTS}-point limit`]
      : [],
  s => (s.doneWhen === undefined || s.doneWhen.trim() === '' ? [`slice ${s.n}: no doneWhen`] : []),
  s => (s.owns.length === 0 ? [`slice ${s.n}: owns no files`] : []),
  (s, names) => s.dependsOn.filter(dep => !names.has(dep)).map(dep => `slice ${s.n}: depends on unknown slice ${dep}`),
]

/** One reason line per failing slice and rule; empty when every slice passes. */
export function lintSlices(slices: readonly PlannedSlice[]): string[] {
  const names = new Set(slices.map(s => s.n))
  return [
    ...duplicateNames(slices),
    ...slices.flatMap(s => RULES.flatMap(rule => rule(s, names))),
    ...dependencyCycle(slices),
  ]
}

function duplicateNames(slices: readonly PlannedSlice[]): string[] {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const s of slices) (seen.has(s.n) ? dupes : seen).add(s.n)
  return [...dupes].map(n => `slice ${n}: n is used by more than one slice`)
}

/** The first dependency cycle found, as one line; known dependencies only. */
function dependencyCycle(slices: readonly PlannedSlice[]): string[] {
  const deps = new Map(slices.map(s => [s.n, s.dependsOn]))
  const done = new Set<string>()
  const visit = (n: string, path: string[]): string[] | undefined => {
    if (path.includes(n)) return [...path.slice(path.indexOf(n)), n]
    if (done.has(n) || !deps.has(n)) return undefined
    for (const dep of deps.get(n) ?? []) {
      const cycle = visit(dep, [...path, n])
      if (cycle !== undefined) return cycle
    }
    done.add(n)
    return undefined
  }
  for (const s of slices) {
    const cycle = visit(s.n, [])
    if (cycle !== undefined) return [`slice ${cycle[0]}: dependency cycle ${cycle.join(' -> ')}`]
  }
  return []
}
