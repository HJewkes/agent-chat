import { holdClass } from '../../shepherd-client.js'
import { BRANCH_PREFIX } from '../isolation/worktree.js'
import { readySlices, type Claim, type Ledger, type StackedOn } from './ledger.js'
import { rowFor, shepherdTarget, type ShepherdRow } from './shepherd.js'

/**
 * CC-1158 slice a: which queued slices may stack on an unmerged parent slice. A parent is a base when its
 * claim is shepherding a PR whose Shepherd run is registered, past its first green CI, not stalled, not
 * `stackFrozen`, and unheld or held only for review (owner decisions 269 D3, 313(a)). Chains are at most
 * `STACK_MAX_DEPTH` unmerged claims long.
 */

export const STACK_MODES = ['off', 'shadow', 'on'] as const
export type StackMode = (typeof STACK_MODES)[number]

/** A parent plus its child; a parent that is itself stacked on an unmerged claim is not a base. */
export const STACK_MAX_DEPTH = 2

/** Shepherd phases a run reaches only once CI went green at its head; `ci` and `fixing` are not yet. */
const CI_GREEN_PHASES: ReadonlySet<ShepherdRow['phase']> = new Set(['review', 'awaiting-approval', 'merging'])

const claimOf = (ledger: Ledger, taskId: string, slice: string): Claim | undefined =>
  ledger.claims.find(c => c.taskId === taskId && c.slice === slice)

/** Unmerged claims in the chain ending at `claim`, itself included; a merged ancestor ends the chain. */
function unmergedDepth(ledger: Ledger, claim: Claim): number {
  let depth = 1
  for (let on = claim.stackedOn; on !== undefined && depth <= STACK_MAX_DEPTH; depth++) {
    const parent = claimOf(ledger, on.taskId, on.slice)
    if (parent === undefined || parent.phase === 'done') break
    on = parent.stackedOn
  }
  return depth
}

/**
 * Owner decision 313(a), amending 269 D3: holds that wait on a reviewer, not on the PR, leave a base. Any other
 * class, an owner or park hold, or one this build does not know, is refused.
 */
const BASE_HOLD_CLASSES: ReadonlySet<string> = new Set(['g10-adversary', 'g10-review', 'no-reviewer'])

const baseHold = (row: ShepherdRow): boolean => {
  if (row.held == null) return true
  const cls = holdClass(row)
  return cls !== undefined && BASE_HOLD_CLASSES.has(cls)
}

const baseRow = (row: ShepherdRow | undefined): boolean =>
  row !== undefined &&
  CI_GREEN_PHASES.has(row.phase) &&
  baseHold(row) &&
  row.stalled === null &&
  row.stackFrozen !== true

/** The parent `dep` of `child` as a stack base, else undefined. */
export function stackable(
  child: Pick<Claim, 'taskId'>,
  dep: string,
  ledger: Ledger,
  rows: readonly ShepherdRow[],
): StackedOn | undefined {
  const parent = claimOf(ledger, child.taskId, dep)
  if (parent?.phase !== 'shepherding' || parent.pr === undefined || parent.stalledReason !== undefined)
    return undefined
  if (unmergedDepth(ledger, parent) + 1 > STACK_MAX_DEPTH) return undefined
  const target = shepherdTarget(parent.pr)
  const row = target === undefined ? undefined : rowFor(rows, target)
  if (!baseRow(row)) return undefined
  const branch =
    row?.branch ?? (parent.agentName === undefined ? undefined : `${BRANCH_PREFIX}${parent.agentName}`)
  return branch === undefined ? undefined : { taskId: parent.taskId, slice: dep, pr: parent.pr, branch }
}

export interface StackReady {
  /** The slices to dispatch: stacked ones only under `on`. */
  ready: Claim[]
  /** Under `shadow`, one line per slice that `on` would have stacked. */
  notes: string[]
}

/** `readySlices` under `mode`: `off` is unchanged, `shadow` adds would-stack notes only, `on` admits stacked slices. */
export function stackReady(
  mode: StackMode,
  ledger: Ledger,
  held: ReadonlyMap<string, unknown>,
  rows: readonly ShepherdRow[],
): StackReady {
  if (mode === 'off') return { ready: readySlices(ledger, held), notes: [] }
  const stacked = readySlices(ledger, held, (child, dep) => stackable(child, dep, ledger, rows))
  if (mode === 'on') return { ready: stacked, notes: [] }
  const notes = stacked.flatMap(c =>
    c.stackedOn === undefined
      ? []
      : [`would stack ${c.taskId} ${c.slice ?? ''} on ${c.stackedOn.slice} ${c.stackedOn.pr}`],
  )
  return { ready: readySlices(ledger, held), notes }
}
