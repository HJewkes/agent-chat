import { claimKey } from './advance.js'
import type { Claim, Ledger } from './ledger.js'

/**
 * The checkpoint request (CC-663): a claim whose lease ended with uncommitted work asks its agent, once, to
 * commit before its seat hears of it. The seat's `dirty-uncommitted` notice waits until the request went out
 * on an earlier tick, so a commit in between closes the finding and nobody is told. A request refused
 * `CHECKPOINT_TRIES` times stops being sent, and the notice goes out saying so.
 */

export const CHECKPOINT_TRIES = 2

type Checkpoint = NonNullable<Claim['checkpoint']>
type Log = (event: string, detail: Record<string, unknown>) => void
type Send = (to: string, text: string) => Promise<{ ok: boolean; reason?: string; unknown?: boolean }>

const isDirty = (claim: Claim): boolean => claim.finding?.code === 'dirty-uncommitted'

const pending = (checkpoint: Checkpoint | undefined): boolean =>
  checkpoint?.sentAt === undefined && (checkpoint?.failed ?? 0) < CHECKPOINT_TRIES

const asks = (claim: Claim): claim is Claim & { agentName: string } =>
  isDirty(claim) && claim.agentName !== undefined

/** Drops the request of a claim whose finding is no longer `dirty-uncommitted`. */
export function settleCheckpoints(ledger: Ledger): Ledger {
  if (!ledger.claims.some(c => c.checkpoint !== undefined && !isDirty(c))) return ledger
  const claims = ledger.claims.map(c => {
    if (c.checkpoint === undefined || isDirty(c)) return c
    const { checkpoint: _closed, ...rest } = c
    return rest
  })
  return { ...ledger, claims }
}

/** Claims whose agent is due a request: a dirty finding and no request sent or given up on. */
export const checkpointsDue = (ledger: Ledger): Claim[] =>
  ledger.claims.filter(c => asks(c) && pending(c.checkpoint))

/** Whether the claim's dirty notice waits: its request had not gone out, nor been given up on, before this tick. */
export const checkpointHolds = (before: Claim | undefined, after: Claim): boolean =>
  asks(after) && pending(before?.checkpoint)

/** Set on a dirty notice whose request never went out. */
export const undeliverable = (claim: Claim): boolean =>
  isDirty(claim) && claim.checkpoint !== undefined && claim.checkpoint.sentAt === undefined

const taskOf = (claim: Claim): string =>
  claim.slice === undefined ? claim.taskId : `${claim.taskId}#${claim.slice}`

export const checkpointText = (claim: Claim): string => {
  const task = taskOf(claim)
  return (
    `Checkpoint for ${task}: your worktree has uncommitted changes and no commit for a full lease. ` +
    'Commit them to this branch now (`git add` the files you changed, then `git commit -m "WIP checkpoint"`), ' +
    'push if the branch is already on origin, then carry on or send your report.'
  )
}

function recorded(ledger: Ledger, claim: Claim, checkpoint: Checkpoint): Ledger {
  const key = claimKey(claim)
  return { ...ledger, claims: ledger.claims.map(c => (claimKey(c) === key ? { ...c, checkpoint } : c)) }
}

/** One send per due claim; a send with no answer counts as sent, as a seat's does. */
export async function sendCheckpoints(
  due: readonly Claim[],
  start: Ledger,
  deps: { send: Send; log: Log; now: Date },
): Promise<{ ledger: Ledger; lines: string[] }> {
  let ledger = start
  const lines: string[] = []
  for (const claim of due.filter(asks)) {
    const reply = await deps
      .send(claim.agentName, checkpointText(claim))
      .catch((err: Error) => ({ ok: false, reason: err.message, unknown: false }))
    const sent = reply.ok || reply.unknown === true
    deps.log('burndown_checkpoint', {
      task: claim.taskId,
      slice: claim.slice,
      agent: claim.agentName,
      ok: sent,
      reason: reply.reason,
    })
    const failed = (claim.checkpoint?.failed ?? 0) + 1
    ledger = recorded(ledger, claim, sent ? { sentAt: deps.now.toISOString() } : { failed })
    lines.push(
      sent
        ? `asked ${claim.agentName} for a checkpoint of ${taskOf(claim)}`
        : `could not ask ${claim.agentName} for a checkpoint of ${taskOf(claim)}: ${reply.reason ?? 'refused'}`,
    )
  }
  return { ledger, lines }
}
