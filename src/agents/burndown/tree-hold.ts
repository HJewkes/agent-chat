import type { Phase } from './ledger.js'
import { heldClaims, LedgerMalformedError, readLedger } from './ledger.js'
import { canonicalPath } from '../spawn-cwd.js'

/**
 * CC-1039: phases in which the tick no longer reads the claim's worktree, so parking it is safe.
 * Every other held phase may still read the tree after its agent exits (an exited-work adopt, a
 * diff assessment, a reviewer spawned into it), and parking it would stall the claim.
 */
const RELEASED_PHASES: ReadonlySet<Phase> = new Set(['awaiting-merge', 'shepherding'])

/** Why the burndown tick still needs `tree`, or undefined when no held claim reads it. */
export function burndownTreeHold(ledgerFile: string, tree: string): string | undefined {
  let held
  try {
    held = heldClaims(readLedger(ledgerFile))
  } catch (err) {
    if (err instanceof LedgerMalformedError) return 'burndown ledger unreadable'
    throw err
  }
  const root = canonicalPath(tree)
  const claim = held.find(
    c => c.worktree !== undefined && !RELEASED_PHASES.has(c.phase) && canonicalPath(c.worktree) === root,
  )
  if (claim === undefined) return undefined
  const slice = claim.slice === undefined ? '' : ` slice ${claim.slice}`
  return `burndown claim ${claim.taskId}${slice} holds the tree in phase ${claim.phase}`
}
