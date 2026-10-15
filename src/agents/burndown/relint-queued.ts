import { z } from 'zod'
import type { Claim, Ledger } from './ledger.js'
import type { PlannedSlice } from './report.js'
import { readSlices } from './report.js'
import type { PlanFile } from './seed-slices.js'
import { ownsDisjoint } from './slice-lint.js'

/**
 * CC-1156: CC-1155's disjoint-owns edge lint, run over slices already seeded into the ledger. A queued,
 * unstacked slice's `dependsOn` edge is listed when the two slices' owns share no path and the task's
 * current plan gives no `dependsWhy`. The list is a dry run; the seat reviews it before any edge is cleared.
 */

export interface FalseEdge {
  taskId: string
  initiative: string
  slice: string
  dep: string
  plan: string
  owns: string[]
  depOwns: string[]
}

export type PlanOf = (claim: Claim) => PlanFile

const planSlices = (file: PlanFile): PlannedSlice[] | undefined =>
  file.text === undefined ? undefined : readSlices(file.text).slices

/** A slice whose plan is missing or fails the lint keeps its edges: its `dependsWhy` cannot be read. */
function edgesOf(claim: Claim, ledger: Ledger, planOf: PlanOf): FalseEdge[] {
  const owns = claim.owns ?? []
  if (owns.length === 0) return []
  const file = planOf(claim)
  const slices = planSlices(file)
  const planned = slices?.find(s => s.n === claim.slice)
  if (planned === undefined || (planned.dependsWhy ?? '').trim() !== '') return []
  return (claim.dependsOn ?? []).flatMap(dep => {
    const depClaim = ledger.claims.find(c => c.taskId === claim.taskId && c.slice === dep)
    if (depClaim?.phase === 'done') return []
    const depOwns = depClaim?.owns ?? slices?.find(s => s.n === dep)?.owns ?? []
    if (depOwns.length === 0 || !ownsDisjoint(owns, depOwns)) return []
    const edge = { taskId: claim.taskId, initiative: claim.initiative, slice: claim.slice as string, dep }
    return [{ ...edge, plan: file.path, owns, depOwns }]
  })
}

const relintable = (claim: Claim, seat: string | undefined): boolean =>
  claim.phase === 'queued' &&
  claim.stackedOn === undefined &&
  claim.slice !== undefined &&
  (seat === undefined || claim.seat === seat)

/** Every listed edge, in ledger order; `seat` narrows it to that seat's claims. */
export function falseEdges(ledger: Ledger, planOf: PlanOf, seat?: string): FalseEdge[] {
  return ledger.claims.filter(c => relintable(c, seat)).flatMap(c => edgesOf(c, ledger, planOf))
}

export const renderFalseEdge = (e: FalseEdge): string =>
  `${e.taskId} ${e.slice} -> ${e.dep}  owns ${e.owns.join(', ')}  dep owns ${e.depOwns.join(', ')}  plan ${e.plan}`

/** CC-1156 b: one edge the seat approved; the dry run's `--json` rows parse as these, extra keys ignored. */
export const ApprovedEdge = z.object({ taskId: z.string(), slice: z.string(), dep: z.string() })
export type ApprovedEdge = z.infer<typeof ApprovedEdge>

export const parseApproved = (text: string): ApprovedEdge[] => z.array(ApprovedEdge).parse(JSON.parse(text))

export interface SkippedEdge {
  edge: ApprovedEdge
  reason: string
}

export interface ApplyResult {
  ledger: Ledger
  cleared: ApprovedEdge[]
  skipped: SkippedEdge[]
}

const sameEdge = (a: ApprovedEdge, b: ApprovedEdge): boolean =>
  a.taskId === b.taskId && a.slice === b.slice && a.dep === b.dep

/** Why an approved edge that the live ledger no longer lists is kept. */
function skipReason(edge: ApprovedEdge, ledger: Ledger): string {
  const claim = ledger.claims.find(
    c => c.taskId === edge.taskId && c.slice === edge.slice && c.phase !== 'done',
  )
  if (claim === undefined) return 'no held claim on that slice'
  if (claim.phase !== 'queued') return `slice is ${claim.phase}`
  if (claim.stackedOn !== undefined) return 'slice is stacked'
  if (!(claim.dependsOn ?? []).includes(edge.dep)) return 'edge already gone'
  return 'no longer listed: the plan now has a dependsWhy, the owns overlap, or the plan is unreadable'
}

const withoutDeps = (claim: Claim, drop: readonly ApprovedEdge[]): Claim => {
  const gone = drop.filter(e => e.taskId === claim.taskId && e.slice === claim.slice).map(e => e.dep)
  if (claim.phase !== 'queued' || gone.length === 0) return claim
  return { ...claim, dependsOn: (claim.dependsOn ?? []).filter(dep => !gone.includes(dep)) }
}

/**
 * Clears each approved edge the live ledger still lists as false, re-checked through `falseEdges`, so an edge
 * whose slice was claimed, stacked or given a `dependsWhy` since the dry run is skipped and reported instead.
 */
export function applyApproved(
  ledger: Ledger,
  approved: readonly ApprovedEdge[],
  planOf: PlanOf,
): ApplyResult {
  const unique = approved.filter((e, i) => approved.findIndex(o => sameEdge(o, e)) === i)
  const live = falseEdges(ledger, planOf)
  const cleared = unique.filter(e => live.some(l => sameEdge(l, e)))
  const skipped = unique
    .filter(e => !cleared.includes(e))
    .map(edge => ({ edge, reason: skipReason(edge, ledger) }))
  const claims = cleared.length === 0 ? ledger.claims : ledger.claims.map(c => withoutDeps(c, cleared))
  return { ledger: { ...ledger, claims }, cleared, skipped }
}

export const renderEdgeKey = (e: ApprovedEdge): string => `${e.taskId} ${e.slice} -> ${e.dep}`
