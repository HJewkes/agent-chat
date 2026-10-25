import { patternsOverlap } from '../../broker/claims.js'
import { HUMAN_OPS, opsHits } from './ops.js'
import { acceptedHolder, type PlannedSlice } from './report.js'

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
  (s, names) =>
    s.dependsOn.filter(dep => !names.has(dep)).map(dep => `slice ${s.n}: depends on unknown slice ${dep}`),
  s => repeatedScopes(s).map(scope => `slice ${s.n}: contract scope ${scope} is declared more than once`),
  s => undeclaredOps(s),
  s =>
    (s.ops ?? [])
      .filter(op => HUMAN_OPS.includes(op))
      .map(op => `slice ${s.n}: declares ${op}; split it into a kind:operator or kind:owner task`),
  s =>
    (s.ops ?? []).includes('publish')
      ? [
          `slice ${s.n}: declares publish; a publish is its own task (ops:publish, done_when "publish <pkg> at <version>", dep: on the build task), not a slice`,
        ]
      : [],
  s => unacceptableOverlaps(s),
]

const GLOB_CHARS = /[*?[{]/

/** CC-1259: an accepted overlap waives one exact owns path; a glob would waive more than the planner read. */
function unacceptableOverlaps(slice: PlannedSlice): string[] {
  return (slice.overlapsAccepted ?? []).flatMap(accept => {
    const { path } = accept
    const holder = acceptedHolder(accept)
    if (GLOB_CHARS.test(path))
      return [`slice ${slice.n}: overlapsAccepted ${holder} path ${path} is a glob; name one exact owns path`]
    if (!slice.owns.includes(path))
      return [`slice ${slice.n}: overlapsAccepted ${holder} path ${path} is not an exact owns entry`]
    return []
  })
}

/**
 * CC-974: a slice that declares ops must declare each op its doneWhen names; `[]` marks every hit
 * as subject matter. A slice with no `ops` field passes until the planner brief asks for one (slice d).
 */
function undeclaredOps(slice: PlannedSlice): string[] {
  if (slice.ops === undefined || slice.ops.length === 0) return []
  const declared = new Set(slice.ops)
  const hits = opsHits(slice.doneWhen ?? '').filter(hit => !declared.has(hit.op))
  if (hits.length === 0) return []
  const named = hits.map(hit => `${hit.op} ('${hit.text}')`).join(', ')
  return [`slice ${slice.n}: doneWhen mentions ${named}, which "ops" does not declare`]
}

function repeatedScopes(slice: PlannedSlice): string[] {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const { scope } of slice.contracts ?? []) (seen.has(scope) ? repeated : seen).add(scope)
  return [...repeated]
}

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

/**
 * CC-1155: advisory lines that never block seeding. A `dependsOn` edge between slices whose owns share
 * no file serialises work that could run in parallel unless `dependsWhy` names the semantic reason, and
 * a linear chain of three or more over disjoint owns is flagged whatever `dependsWhy` says.
 */
export function sliceWarnings(slices: readonly PlannedSlice[]): string[] {
  const byName = new Map(slices.map(s => [s.n, s]))
  return [
    ...slices.flatMap(s => unexplainedEdges(s, byName)),
    ...disjointChains(slices, byName),
    ...slices.flatMap(undeclaredPublish),
  ]
}

/** CC-987: a publish mention with no `ops` field may be subject matter, so it warns rather than fails. */
function undeclaredPublish(slice: PlannedSlice): string[] {
  if (slice.ops !== undefined) return []
  const hit = opsHits(slice.doneWhen ?? '').find(h => h.op === 'publish')
  if (hit === undefined) return []
  return [
    `slice ${slice.n}: doneWhen mentions publish ('${hit.text}'); if this slice publishes, move it to its own task; else add "ops": []`,
  ]
}

type ByName = ReadonlyMap<string, PlannedSlice>

/** CC-1156 reuses this predicate on ledger claims, so it takes bare owns lists. */
export const ownsDisjoint = (a: readonly string[], b: readonly string[]): boolean =>
  !a.some(own => b.some(other => patternsOverlap(own, other)))

const disjoint = (a: PlannedSlice, b: PlannedSlice): boolean => ownsDisjoint(a.owns, b.owns)

function unexplainedEdges(slice: PlannedSlice, byName: ByName): string[] {
  if ((slice.dependsWhy ?? '').trim() !== '') return []
  return slice.dependsOn
    .filter(dep => {
      const target = byName.get(dep)
      return target !== undefined && disjoint(slice, target)
    })
    .map(
      dep =>
        `slice ${slice.n}: depends on ${dep} but their owns are disjoint; set dependsOn [] or say why in dependsWhy`,
    )
}

/** Each maximal run back from a slice nothing depends on, through slices that each depend on exactly one. */
function disjointChains(slices: readonly PlannedSlice[], byName: ByName): string[] {
  const depended = new Set(slices.flatMap(s => s.dependsOn))
  return slices
    .filter(s => !depended.has(s.n))
    .map(tail => chainEndingAt(tail, byName))
    .filter(
      chain => chain.length >= 3 && chain.every((s, i) => chain.slice(i + 1).every(t => disjoint(s, t))),
    )
    .map(
      chain =>
        `slices ${chain.map(s => s.n).join(' -> ')} form a linear chain over disjoint owns; check each edge is real`,
    )
}

function chainEndingAt(tail: PlannedSlice, byName: ByName): PlannedSlice[] {
  const chain = [tail]
  let current: PlannedSlice | undefined = tail
  while (current.dependsOn.length === 1) {
    current = byName.get(current.dependsOn[0] as string)
    if (current === undefined || chain.includes(current)) break
    chain.unshift(current)
  }
  return chain
}
