import path from 'node:path'
import { parseSeat } from '../seats/charter.js'
import { dispatchLogPath } from '../seats/dispatch-log.js'
import { foldDispatch, type DispatchRecord } from '../seats/dispatch-record.js'
import { readTextIfPresent } from '../seats/io.js'
import type { Claim } from './ledger.js'
import { BRANCH_PREFIX } from '../isolation/worktree.js'
import { jsonLines, originRepo } from './pr-adopt-ports.js'
import type { ClaimPr } from './pr-state.js'
import { targetRef } from './shepherd.js'
import { run, type Runner } from './exec.js'
import type { SeatDispatch } from './seat-dispatch.js'

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

/** The slice agents already run for a task, with their branch PRs in the task's initiative's checkouts (CC-1121 b). */
export type SliceRuns = (taskId: string, initiative: string) => OffLedgerRun[]

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

/** The agent's earliest timestamped dispatch in the seat's log, if any. */
const firstDispatch = (records: readonly DispatchRecord[], agent: string): string | undefined =>
  records
    .filter(r => r.agent === agent && r.ts !== null)
    .map(r => r.ts as string)
    .sort()[0]

/** Each agent's first dispatch in the seat's log; an agent whose rows carry no time is left out. */
export function firstDispatches(
  records: readonly DispatchRecord[],
  agents: readonly string[],
): Record<string, string> {
  const since = agents.map((agent): [string, string | undefined] => [agent, firstDispatch(records, agent)])
  return Object.fromEntries(since.filter((e): e is [string, string] => e[1] !== undefined))
}

/**
 * The task's slice agents, each with its branch PR counted from its first dispatch. The one place seeding and the
 * drift resync read a run's PR (CC-1240). A run with no dispatch time has no PR: a reused name shares its branch
 * with earlier runs, so any merge on it could be an older run's work. Such a slice waits on a release.
 */
export function offLedgerRunsIn(
  ranSince: Readonly<Record<string, string>>,
  agents: readonly string[],
  prOf: BranchPr,
): OffLedgerRun[] {
  return agents.map(agent => {
    const since = ranSince[agent]
    return { agent, slice: agent.slice(-1), pr: since === undefined ? { kind: 'none' } : prOf(agent, since) }
  })
}

// REST, never GraphQL: the owner's account hits GraphQL rate limits.
const BRANCH_JQ = '.[] | {number, state, mergedAt: .merged_at, headSha: .head.sha}'

interface BranchPull {
  number: number
  state: string
  mergedAt: string | null
  headSha: string
}

/** Every PR GitHub lists for the agent's branch in `repo`; undefined only when the read failed. */
function branchPulls(repo: string, agent: string, exec: Runner): BranchPull[] | undefined {
  const owner = repo.split('/')[0] ?? ''
  const head = encodeURIComponent(`${owner}:${BRANCH_PREFIX}${agent}`)
  const result = exec('gh', [
    'api',
    `repos/${repo}/pulls?state=all&head=${head}&per_page=100`,
    '--jq',
    BRANCH_JQ,
  ])
  if (result.status !== 0) return undefined
  const pulls = jsonLines(result.stdout) as Partial<BranchPull>[]
  return pulls.every(p => typeof p?.number === 'number' && typeof p.state === 'string')
    ? pulls.map(p => ({
        number: p.number!,
        state: p.state!,
        mergedAt: p.mergedAt ?? null,
        headSha: p.headSha ?? '',
      }))
    : undefined
}

/** An open PR wins; else the newest merge since the run was dispatched; else none. */
function branchState(repo: string, pulls: readonly BranchPull[], since: string): ClaimPr {
  const open = pulls.find(p => p.state === 'open')
  if (open !== undefined) return { kind: 'open', pr: targetRef({ repo, pr: open.number }) }
  const merged = pulls
    .filter(p => p.mergedAt !== null && Date.parse(p.mergedAt) >= Date.parse(since))
    .sort((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? ''))[0]
  return merged === undefined
    ? { kind: 'none' }
    : { kind: 'merged', pr: targetRef({ repo, pr: merged.number }), head: merged.headSha }
}

/**
 * Asks GitHub for each agent's branch PRs in every checkout's repo, reading each checkout's origin once and only
 * when a run is looked up. A checkout with no GitHub origin has no PR. An open PR in any repo wins over a merged
 * one, and only a failed `gh` read makes the answer "could not tell".
 */
export function branchPrReader(checkouts: readonly string[], exec: Runner): BranchPr {
  let repos: string[] | undefined
  return (agent, since) => {
    repos ??= [...new Set([...new Set(checkouts)].map(c => originRepo(c, exec)).filter(r => r !== undefined))]
    const states = repos.map(repo => {
      const pulls = branchPulls(repo, agent, exec)
      return pulls === undefined ? undefined : branchState(repo, pulls, since)
    })
    if (states.some(s => s === undefined)) return undefined
    return states.find(s => s?.kind === 'open') ?? states.find(s => s?.kind === 'merged') ?? { kind: 'none' }
  }
}

/** CC-1233: one branch-PR reader per initiative, over its git checkouts only, made when a task of it is seeded. */
export function initiativePrReaders(
  { repos, nonGitRepos = [] }: Pick<SeatDispatch, 'repos' | 'nonGitRepos'>,
  exec: Runner = run,
): (initiative: string) => BranchPr {
  const readers = new Map<string, BranchPr>()
  return initiative => {
    const checkouts = (repos[initiative] ?? []).filter(r => !nonGitRepos.includes(r))
    if (!readers.has(initiative)) readers.set(initiative, branchPrReader(checkouts, exec))
    return readers.get(initiative) as BranchPr
  }
}

/** CC-1240: the branch-PR reader of a seat's checkouts for an initiative; undefined when the seat is not loaded. */
export type SeatPrReader = (seat: string, initiative: string) => BranchPr | undefined

/** One `initiativePrReaders` per loaded seat, made on first use, so the resync reads GitHub only for a held slice. */
export function seatPrReader(seats: readonly SeatDispatch[], exec: Runner = run): SeatPrReader {
  const readers = new Map<string, (initiative: string) => BranchPr>()
  return (seat, initiative) => {
    const dispatch = seats.find(s => s.seat === seat)
    if (dispatch === undefined) return undefined
    if (!readers.has(seat)) readers.set(seat, initiativePrReaders(dispatch, exec))
    return (readers.get(seat) as (initiative: string) => BranchPr)(initiative)
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
