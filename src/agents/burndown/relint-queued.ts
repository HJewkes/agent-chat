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
