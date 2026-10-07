import type { Claim, Phase } from './ledger.js'

/**
 * The claim-phase transition table (CC-674): every (from, to) phase edge the
 * burndown code can emit, checked when the ledger is written. An edge not here
 * throws; there is no force path. A write that keeps a claim's phase is not an
 * edge, and reading a ledger from disk checks nothing.
 */

/** A spawn's landing and an undone spawn both leave `spawning`; a release sends any held phase to `queued`. */
export const PHASE_EDGES: Readonly<Record<Phase, readonly Phase[]>> = {
  queued: ['spawning'],
  spawning: ['queued', 'planning', 'implementing', 'parked', 'reviewing'],
  planning: ['spawning', 'queued', 'done'],
  implementing: ['spawning', 'queued', 'parked', 'shepherding', 'done'],
  parked: ['spawning', 'queued'],
  reviewing: ['spawning', 'queued', 'shepherding'],
  'awaiting-merge': ['queued', 'shepherding', 'done'],
  shepherding: ['queued', 'done'],
  done: [],
}

export class IllegalPhaseEdgeError extends Error {
  override name = 'IllegalPhaseEdgeError'
}

export interface IllegalEdge {
  claim: string
  from: Phase
  to: Phase
}

type Held = Pick<Claim, 'taskId' | 'slice' | 'phase'>

const keyOf = (c: Held): string => `${c.taskId}#${c.slice ?? ''}`

/** Claims of one key pair by position: a release drops the newest, a dispatch appends, and a done claim keeps its place. */
function byKey(claims: readonly Held[]): Map<string, Held[]> {
  const groups = new Map<string, Held[]>()
  for (const c of claims) groups.set(keyOf(c), [...(groups.get(keyOf(c)) ?? []), c])
  return groups
}

/** The phase changes from `before` to `after` that the table does not allow. */
export function illegalEdges(before: readonly Held[], after: readonly Held[]): IllegalEdge[] {
  const prior = byKey(before)
  return [...byKey(after)].flatMap(([claim, now]) =>
    now.flatMap((c, i): IllegalEdge[] => {
      const was = prior.get(claim)?.[i]
      if (was === undefined || was.phase === c.phase || PHASE_EDGES[was.phase].includes(c.phase)) return []
      return [{ claim, from: was.phase, to: c.phase }]
    }),
  )
}
