import path from 'node:path'
import { parseSeat } from '../seats/charter.js'
import { dispatchLogPath } from '../seats/dispatch-log.js'
import { foldDispatch, type DispatchRecord } from '../seats/dispatch-record.js'
import { readTextIfPresent } from '../seats/io.js'
import type { Runner } from './exec.js'
import type { Claim } from './ledger.js'
import { originRepo } from './pr-adopt-ports.js'
import { claimPrState, readRepoPulls, type ClaimPr, type RepoPulls } from './pr-state.js'

/**
 * CC-1233 (D3): a plan whose slice agents ran by hand, outside the ledger, is seeded by what each run left on
 * GitHub rather than refused. A run whose branch PR merged becomes a done claim, an open PR a shepherding claim
 * with the PR linked, and a slice with no run is queued. A run with no open or merged PR, such as a live agent
 * still at work, gets no claim, so nothing dispatches its slice a second time.
 */

/** One `<prefix>-<id>-<slice>` agent from the seat's dispatch log and its branch PR; `pr` undefined: could not tell. */
export interface OffLedgerRun {
  agent: string
  slice: string
  pr: ClaimPr | undefined
}

/** The slice agents already run for a task, with their branch PRs (CC-1121 b). */
export type SliceRuns = (taskId: string) => OffLedgerRun[]

/** The PR on `agent`'s branch, counting a merge only after `since`; undefined when a read failed. */
export type BranchPr = (agent: string, since: string) => ClaimPr | undefined

/** The run's claim for an adopted slice, or undefined when its slice is left alone. */
function adopted(claim: Claim, run: OffLedgerRun): Claim | undefined {
  const pr = run.pr
  if (pr?.kind !== 'merged' && pr?.kind !== 'open') return undefined
  const held = { ...claim, agentName: run.agent, spawned: [run.agent], pr: pr.pr }
  return pr.kind === 'merged'
    ? { ...held, phase: 'done', prHead: pr.head }
    : { ...held, phase: 'shepherding' }
}

/** The queued slice claims with each off-ledger run's slice adopted or left out, and a note for each run. */
export function adoptOffLedger(
  queued: readonly Claim[],
  runs: readonly OffLedgerRun[],
): { claims: Claim[]; notes: string[] } {
  const claims: Claim[] = []
  const notes: string[] = []
  for (const claim of queued) {
    const run = runs.find(r => r.slice === claim.slice)
    if (run === undefined) {
      claims.push(claim)
      continue
    }
    const kept = adopted(claim, run)
    if (kept !== undefined) claims.push(kept)
    notes.push(
      kept === undefined
        ? `left ${claim.initiative} ${claim.taskId} slice ${claim.slice} to ${run.agent}, which ran outside the ledger and has no open or merged PR`
        : `adopted ${claim.initiative} ${claim.taskId} slice ${claim.slice} from ${run.agent} as ${kept.phase} with ${kept.pr}`,
    )
  }
  return { claims, notes }
}

/** The task's slice agents in the seat's dispatch log, each with its first dispatch and its branch PR. */
export function offLedgerRunsIn(
  records: readonly DispatchRecord[],
  agents: readonly string[],
  prOf: BranchPr,
): OffLedgerRun[] {
  return agents.map(agent => {
    const since = records
      .filter(r => r.agent === agent && r.ts !== null)
      .map(r => r.ts as string)
      .sort()[0]
    return { agent, slice: agent.slice(-1), pr: prOf(agent, since ?? new Date(0).toISOString()) }
  })
}

/**
 * Reads each checkout's origin and each repo's pulls at most once, and only when a run is looked up. An open PR
 * in any repo wins over a merged one; a repo that could not be read makes the answer "could not tell".
 */
export function branchPrReader(checkouts: readonly string[], exec: Runner): BranchPr {
  const pulls = new Map<string, RepoPulls | undefined>()
  const repos = (): (string | undefined)[] => [...new Set(checkouts)].map(c => originRepo(c, exec))
  let origins: (string | undefined)[] | undefined
  return (agent, since) => {
    origins ??= repos()
    const probe: Claim = {
      taskId: '',
      initiative: '',
      spawnedAt: since,
      phase: 'queued',
      phaseAt: since,
      spawned: [agent],
    }
    const states = [...new Set(origins)].map(repo => {
      if (repo === undefined) return undefined
      if (!pulls.has(repo)) pulls.set(repo, readRepoPulls(repo, exec))
      return claimPrState(probe, repo, pulls.get(repo))
    })
    return (
      states.find(s => s?.kind === 'open') ??
      states.find(s => s?.kind === 'merged') ??
      (states.every(s => s !== undefined) ? { kind: 'none' } : undefined)
    )
  }
}

/** The seat's dispatch log folded into runs, undefined when it does not exist yet; any other fault throws. */
export function seatDispatchRecords(autonomyRoot: string, seat: string): DispatchRecord[] | undefined {
  const text = readTextIfPresent(path.join(autonomyRoot, 'seats', `${seat}.md`))
  const parsed = text === undefined ? undefined : parseSeat(seat, text)
  if (text === undefined || parsed === undefined) throw new Error(`${seat} is not a seat`)
  const file = dispatchLogPath(autonomyRoot, { seat: parsed, text })
  if (file === undefined) throw new Error(`${seat} dispatch_log resolves outside the root`)
  const log = readTextIfPresent(file)
  return log === undefined ? undefined : foldDispatch(log).records
}
