import fs from 'node:fs'
import path from 'node:path'
import type { AgentIdentity } from '../../protocol.js'
import { BRANCH_PREFIX } from '../isolation/worktree.js'
import { isReviewerTreeName } from '../reviewer-tree.js'
import { findTranscript } from '../transcript.js'
import { readTranscriptSpend, type TranscriptSpendRead } from '../transcript-spend.js'
import { githubRepoOf } from '../spawn-provenance.js'
import { finalAssistantText, readActivity } from '../turns.js'
import { claimKey, type InboxMessage, type Observation } from './advance.js'
import { planPathFor } from './brief.js'
import { readPrFiles, type HeldOwns } from './collision.js'
import { run, type Runner } from './exec.js'
import { readExitedWork, type ExitedWork } from './exited-adopt.js'
import { AGENT_PHASES, sameClaim, type Claim, type Phase } from './ledger.js'
import { DEFAULT_NAME_PREFIX, type WorktreeUse } from './plan.js'
import type { ClaimPr } from './pr-state.js'
import { readProgress, type Progress } from './progress.js'
import { defaultAutonomyRoot, loadPolicy } from './policy.js'
import { adjudicateOutside, type Adjudication, type OtherPr } from './owns-adjudicate.js'
import { outsideOwns } from './owns-fence.js'
import { prFactsReader, type PrFacts } from './pr-facts.js'
import { parseReport, readSlices, type Report } from './report.js'
import { sumSpend } from './spend-cap.js'
import type { ActivityRead } from './stall.js'
import { assessDiff, GIT_BIN, resolveBaseRef, type DiffVerdict } from './review-diff.js'
import {
  FINISHED_PHASES,
  rowFor,
  shepherdLanded,
  shepherdRows,
  shepherdTarget,
  type ShepherdRow,
  type ShepherdTarget,
} from './shepherd.js'
import { worktreePathFor } from './trust-gate.js'

/**
 * The tick's reads: what the broker, the transcripts, git and Shepherd say about
 * each held claim. Every read that fails is reported as "could not tell"
 * rather than as a fact, so `advance` never moves a claim on a guess.
 */

export interface Roster {
  agents: AgentIdentity[]
  /** The broker's live semaphore; absent from an older broker, which the tick treats as no free slots. */
  slots?: { held: number; cap: number }
  /** Why the retired rows are missing (CC-777): a name absent from a partial roster is unknown, not gone. */
  partial?: string
}

export interface ObserveDeps {
  inboxSince: (name: string, afterId: number) => Promise<InboxMessage[]>
  /** Whether a task's tags now hold `brief:proposed`; absent reads as not proposed. */
  proposed?: (initiative: string, taskId: string) => boolean
  /** The active-work root, where a planner's plan file lives. */
  root: string
  finalText?: (agent: AgentIdentity) => string | undefined
  diff?: (cwd: string) => DiffVerdict
  /** The files a worktree's branch changed against its base (CC-669); undefined when git could not tell. */
  changedFiles?: (cwd: string) => string[] | undefined
  /** Every row `shepherd status` lists; observe calls it at most once per tick. */
  shepherdRows?: () => ShepherdRow[] | undefined
  landed?: (target: ShepherdTarget) => boolean | undefined
  readFile?: (file: string) => string | undefined
  /** The row's transcript activity; defaults to `readActivity`. */
  activity?: (agent: AgentIdentity) => ActivityRead
  /** A worktree's progress evidence; defaults to `readProgress`. */
  progress?: (worktree: string) => Progress | 'unreadable'
  /** One agent's whole-session transcript spend; defaults to `findTranscript` plus `readTranscriptSpend`. */
  spend?: (agent: AgentIdentity) => Promise<TranscriptSpendRead>
  /** A seat's `spend.per_claim_usd`; observe reads it once per seat per tick, and a throw means no cap. */
  spendCap?: (seat: string) => number | undefined
  /** What an exited implementer with no readable status left in its worktree (CC-673); defaults to `readExitedWork`. */
  exitedWork?: (worktree: string) => ExitedWork | undefined
  /** CC-1023: the files of a silent exit's adopted PR, undefined when GitHub could not tell; absent reads nothing. */
  prFiles?: (pr: string) => string[] | undefined
  /** CC-1054: GitHub's word on a claim's PR, undefined when it could not tell; absent reads nothing. */
  prState?: (claim: Claim) => ClaimPr | undefined
  /**
   * CC-1150 f: a checkout's open PRs, each with a lazy file list, for adjudicating an outside-owns PR; undefined
   * when unreadable. Absent, the tick's readers serve a caller that passes `shepherdRows`, and others adjudicate nothing.
   */
  openPrs?: (checkout: string) => readonly CheckoutPr[] | undefined
}

export interface CheckoutPr extends OtherPr {
  branch: string
}

type Adjudicator = (claim: Claim, outside: string[], report: Report | undefined) => Adjudication

export interface Observed {
  observations: Map<string, Observation>
  /** Claims the tick could not read this run, and why; `advance` sees nothing for them. */
  unread: string[]
}

const isAgentPhase = (phase: Claim['phase']): boolean => (AGENT_PHASES as readonly string[]).includes(phase)

export const LIVE = new Set(['spawning', 'live', 'detached'])
const FINISHED = new Set(['exited', 'retired'])

/** The newest row carrying `name`: names are reused across spawns, identities are not. */
export const rowNamed = (roster: Roster, name: string | undefined): AgentIdentity | undefined =>
  name === undefined
    ? undefined
    : roster.agents.filter(a => a.name === name).sort((a, b) => b.spawnedAt - a.spawnedAt)[0]

const readFileOrUndefined = (file: string): string | undefined => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

const defaultActivity = (agent: AgentIdentity): ActivityRead =>
  readActivity(agent.cwd, agent.sessionId, agent.configDir === '' ? undefined : agent.configDir)

const defaultProgress = (worktree: string): Progress | 'unreadable' => readProgress(worktree)

const defaultSpend = (agent: AgentIdentity): Promise<TranscriptSpendRead> =>
  readTranscriptSpend(
    findTranscript(agent.cwd, agent.sessionId, agent.configDir === '' ? undefined : agent.configDir).path,
  )

const defaultSpendCap =
  (root: string) =>
  (seat: string): number | undefined =>
    loadPolicy(defaultAutonomyRoot(root), seat).seat.spend.per_claim_usd

/** A seat file that fails to load gives no cap, so a bad seat never breaks the tick's observe. */
function capsBySeat(read: (seat: string) => number | undefined): (seat: string) => number | undefined {
  const caps = new Map<string, number | undefined>()
  const capOf = (seat: string): number | undefined => {
    try {
      return read(seat)
    } catch {
      return undefined
    }
  }
  return seat => {
    if (!caps.has(seat)) caps.set(seat, capOf(seat))
    return caps.get(seat)
  }
}

const defaultFinalText = (agent: AgentIdentity): string | undefined =>
  finalAssistantText(agent.cwd, agent.sessionId, agent.configDir === '' ? undefined : agent.configDir)

export async function observe(claims: Claim[], roster: Roster, deps: ObserveDeps): Promise<Observed> {
  const observations = new Map<string, Observation>()
  const unread: string[] = []
  const once = {
    ...deps,
    shepherdRows: memo(deps.shepherdRows ?? (() => shepherdRows())),
    spendCap: capsBySeat(deps.spendCap ?? defaultSpendCap(deps.root)),
  }
  // Only a caller that passes its own reader, as the tick does, has implementing claims looked up in Shepherd.
  const prRuns = deps.shepherdRows === undefined ? undefined : once
  const openPrs = deps.openPrs ?? (deps.shepherdRows === undefined ? undefined : tickOpenPrs())
  const adjudicate = openPrs === undefined ? undefined : adjudicator(claims, openPrs)
  for (const claim of claims) {
    const result = await observeClaim(claim, roster, once, adjudicate)
    if (typeof result === 'string') {
      const settled = mergedOnGitHub(claim, deps.prState)
      if (settled === undefined) unread.push(`${claimKey(claim)}: ${result}`)
      else observations.set(claimKey(claim), settled)
    } else {
      const observed = prRuns === undefined ? result : withPrRun(result, claim, prRuns)
      observations.set(claimKey(claim), withPrState(observed, claim, deps.prState))
    }
  }
  return { observations, unread }
}

/**
 * CC-1150: a merge GitHub reports settles a claim whose Shepherd read failed, so an outage cannot pin it. Any
 * other answer, or none, leaves the claim unread: an open or unknown PR is not an observation to act on.
 */
function mergedOnGitHub(claim: Claim, read: ObserveDeps['prState']): Observation | undefined {
  if (read === undefined || !PR_STATE_PHASES.has(claim.phase)) return undefined
  const prState = read(claim)
  return prState?.kind === 'merged' ? { prState } : undefined
}

/**
 * CC-978: the Shepherd run of an implementing claim's PR, or of a queued slice linked to a hand-dispatched
 * one, so a merge finishes the claim whether or not its agent exited. A read that fails leaves the claim as observed.
 */
function withPrRun(obs: Observation, claim: Claim, deps: ObserveDeps): Observation {
  if (claim.phase !== 'implementing' && !(claim.phase === 'queued' && claim.pr !== undefined)) return obs
  const row = claimRun(claim, deps.shepherdRows?.() ?? [])
  if (row === undefined || row.pr === null) return obs
  if (row.phase !== 'done' || row.outcome?.kind === 'merged') return { ...obs, shepherd: { row } }
  const landed = (deps.landed ?? (t => shepherdLanded(t)))({ repo: row.repo, pr: row.pr })
  return landed === undefined ? obs : { ...obs, shepherd: { row, landed } }
}

const SETTLED_STALLS: ReadonlySet<Phase> = new Set(['spawning', 'reviewing'])
const PR_STATE_PHASES: ReadonlySet<Phase> = new Set(['implementing', 'reviewing', 'shepherding'])

/**
 * CC-1054: read for every implementing claim, and for a stalled one whose agent ran or should have. CC-1074:
 * and for a shepherding claim, so its merge finishes it when Shepherd's row is gone, ended or behind. CC-1098:
 * and for a reviewing claim, so a PR merged under review closes it in the same tick.
 */
function withPrState(obs: Observation, claim: Claim, read: ObserveDeps['prState']): Observation {
  const reads =
    PR_STATE_PHASES.has(claim.phase) || (claim.stalledReason !== undefined && SETTLED_STALLS.has(claim.phase))
  if (read === undefined || !reads) return obs
  return { ...obs, prState: read(claim) ?? 'unreadable' }
}

/**
 * The claim's recorded PR, else an open run its agents registered or whose branch is one of theirs. Agent
 * names repeat across dispatches of a task, so a name match only links an open PR and never finishes the
 * claim: a finished run under the same name may be an earlier dispatch's.
 */
export function claimRun(claim: Claim, rows: readonly ShepherdRow[]): ShepherdRow | undefined {
  if (claim.pr !== undefined) {
    const target = shepherdTarget(claim.pr)
    return target === undefined ? undefined : rowFor(rows, target)
  }
  const names = new Set([
    ...(claim.spawned ?? []),
    ...(claim.agentName === undefined ? [] : [claim.agentName]),
  ])
  const ours = (r: ShepherdRow): boolean =>
    (r.implementer != null && names.has(r.implementer)) ||
    (r.branch?.startsWith(BRANCH_PREFIX) === true && names.has(r.branch.slice(BRANCH_PREFIX.length)))
  const open = (r: ShepherdRow): boolean => r.phase !== 'post-merge' && !FINISHED_PHASES.includes(r.phase)
  return rows.find(r => r.pr !== null && open(r) && ours(r))
}

async function observeClaim(
  claim: Claim,
  roster: Roster,
  deps: ObserveDeps,
  adjudicate?: Adjudicator,
): Promise<Observation | string> {
  const row = rowNamed(roster, claim.agentName)
  if (row === undefined && claim.agentName !== undefined && roster.partial !== undefined)
    return `no live row for ${claim.agentName} and ${roster.partial}`
  const obs: Observation = row === undefined ? {} : { agent: { id: row.agentId, state: row.state } }
  if (claim.phase === 'parked' && claim.agentName !== undefined) {
    const afterId = Number.parseInt(claim.inboxCursor ?? '0', 10)
    obs.inbox = await deps.inboxSince(claim.agentName, Number.isInteger(afterId) ? afterId : 0)
  }
  const spend = await claimSpend(claim, roster, deps)
  if (spend !== undefined) obs.spend = spend
  if (claim.phase === 'awaiting-merge' || claim.phase === 'shepherding') return withShepherd(obs, claim, deps)
  if (row !== undefined && LIVE.has(row.state) && isAgentPhase(claim.phase))
    obs.activity = { read: (deps.activity ?? defaultActivity)(row), spawnedAt: row.spawnedAt }
  if (
    row !== undefined &&
    LIVE.has(row.state) &&
    claim.phase === 'implementing' &&
    claim.worktree !== undefined
  )
    obs.progress = (deps.progress ?? defaultProgress)(claim.worktree)
  if (row === undefined || !FINISHED.has(row.state) || claim.phase === 'spawning') return obs
  const text = (deps.finalText ?? defaultFinalText)(row)
  if (text !== undefined) obs.report = parseReport(text)
  if (claim.phase === 'planning' && claim.briefer === true) {
    obs.proposed = deps.proposed?.(claim.initiative, claim.taskId) ?? false
    return obs
  }
  if (claim.phase === 'planning') return withSlices(obs, claim, deps)
  if (claim.phase === 'implementing' && (claim.owns ?? []).length > 0)
    obs.owned = ownedRead(claim, deps, adjudicate, obs.report)
  if (claim.phase === 'implementing' && claim.worktree !== undefined) {
    obs.diff = (deps.diff ?? assessDiff)(claim.worktree)
    return withAdoptedPrOwns(withExitedWork(obs, claim.worktree, deps), claim, deps, adjudicate)
  }
  if (claim.phase === 'reviewing') return withShepherd(obs, claim, deps)
  return obs
}

function ownedRead(
  claim: Claim,
  deps: ObserveDeps,
  adjudicate: Adjudicator | undefined,
  report: Report | undefined,
): NonNullable<Observation['owned']> {
  const files = claim.worktree === undefined ? undefined : (deps.changedFiles ?? changedFiles)(claim.worktree)
  if (files === undefined) return 'unreadable'
  return judged(claim, outsideOwns(files, claim.owns ?? []), adjudicate, report)
}

function judged(
  claim: Claim,
  outside: string[],
  adjudicate: Adjudicator | undefined,
  report: Report | undefined,
): NonNullable<Observation['owned']> {
  if (outside.length === 0 || adjudicate === undefined) return { outside }
  return { outside, adjudicated: adjudicate(claim, outside, report) }
}

/**
 * CC-1023: a silent exit's open PR carries what was pushed, which a worktree reset to its base no longer shows, so
 * the owns read adds the PR's own files. Only for a claim with owns, so a claim that owns nothing reads no PR.
 */
function withAdoptedPrOwns(
  obs: Observation,
  claim: Claim,
  deps: ObserveDeps,
  adjudicate: Adjudicator | undefined,
): Observation {
  const { owned, exitedWork } = obs
  if (typeof owned !== 'object' || typeof exitedWork !== 'object' || exitedWork.openPr === null) return obs
  if (deps.prFiles === undefined) return obs
  const files = deps.prFiles(exitedWork.openPr)
  if (files === undefined) return { ...obs, owned: 'unreadable' }
  const added = outsideOwns(files, claim.owns ?? []).filter(file => !owned.outside.includes(file))
  if (added.length === 0) return obs
  return { ...obs, owned: judged(claim, [...owned.outside, ...added], adjudicate, obs.report) }
}

/** A claim's checkout: its worktree's repo (`<repo>/.worktrees/<name>`), else the plan's. */
const checkoutOf = (claim: Claim): string | undefined =>
  claim.worktree === undefined ? claim.repo : path.dirname(path.dirname(claim.worktree))

/** The changesets Version Packages PR, which collision skips too: it only deletes changesets. */
const RELEASE_BRANCH = 'changeset-release/'

/** CC-1150 f: the context each outside-owns PR is judged in: the other held claims and the other open PRs. */
function adjudicator(claims: Claim[], openPrs: NonNullable<ObserveDeps['openPrs']>): Adjudicator {
  return (claim, outside, report) => {
    const checkout = checkoutOf(claim)
    const others = (): readonly OtherPr[] | undefined =>
      checkout === undefined ? undefined : openPrs(checkout)?.filter(notOwn(claim, report))
    return adjudicateOutside(outside, { held: heldOwns(claims, claim, checkout), openPrs: others })
  }
}

/** As collision's `heldOwns`: dispatched claims other than this one, in its repo; a queued claim holds nothing yet. */
function heldOwns(claims: Claim[], claim: Claim, checkout: string | undefined): HeldOwns[] {
  return claims.flatMap(c => {
    const repo = checkoutOf(c)
    const owns = c.owns ?? []
    if (c.phase === 'queued' || sameClaim(c, claim) || owns.length === 0 || repo === undefined) return []
    if (repo !== checkout) return []
    return [{ holder: `${c.taskId}${c.slice === undefined ? '' : ` slice ${c.slice}`}`, repo, owns }]
  })
}

/** The claim's own PR, by number or by one of its agents' branches, and the Version Packages PR are no collision. */
function notOwn(claim: Claim, report: Report | undefined): (pr: CheckoutPr) => boolean {
  const ownPr = shepherdTarget(report?.pr ?? claim.pr)?.pr
  const names = [...(claim.spawned ?? []), ...(claim.agentName === undefined ? [] : [claim.agentName])]
  const ownBranches = new Set(names.map(name => `${BRANCH_PREFIX}${name}`))
  return pr => pr.number !== ownPr && !ownBranches.has(pr.branch) && !pr.branch.startsWith(RELEASE_BRANCH)
}

/**
 * The tick's open-PR reader: CC-1157's one ETag read per repo, then each PR's files only when asked. A stale or
 * truncated list reads as unreadable, since a PR missing from it may be the one that collides.
 */
function tickOpenPrs(exec: Runner = run): (checkout: string) => readonly CheckoutPr[] | undefined {
  const facts = prFactsReader({ exec })
  const lists = new Map<string, readonly CheckoutPr[] | undefined>()
  return checkout => {
    if (!lists.has(checkout)) lists.set(checkout, checkoutPrs(checkout, facts, exec))
    return lists.get(checkout)
  }
}

export function checkoutPrs(
  checkout: string,
  facts: (repo: string) => PrFacts | undefined,
  exec: Runner,
): CheckoutPr[] | undefined {
  const origin = exec(GIT_BIN, ['-C', checkout, 'remote', 'get-url', 'origin'])
  const repo = origin.status === 0 ? githubRepoOf(origin.stdout) : undefined
  const read = repo === undefined ? undefined : facts(repo)
  if (read === undefined || read.stale || !read.complete) return undefined
  return read.prs.map(pr => ({
    number: pr.number,
    branch: pr.branch,
    files: memo(() => readPrFiles(checkout, pr.number, exec)),
  }))
}

/**
 * Committed changes only: the PR carries what was pushed, not what the worktree still holds. `--no-renames` lists a
 * moved file's old path too, so moving a protected file out of its tree still reads as touching it (CC-1150 f).
 */
export function changedFiles(cwd: string, exec: Runner = run): string[] | undefined {
  const base = resolveBaseRef(cwd, exec)
  if (base === undefined) return undefined
  const result = exec(GIT_BIN, ['diff', '--no-renames', '--name-only', `${base}...HEAD`], cwd)
  return result.status === 0 ? result.stdout.split('\n').filter(line => line !== '') : undefined
}

/** Read only for an exit with no status line: a report already says what the agent left. */
function withExitedWork(obs: Observation, worktree: string, deps: ObserveDeps): Observation {
  const silent =
    obs.report === undefined || (obs.report.status === 'unknown' && obs.report.parked === undefined)
  if (!silent || !fs.existsSync(worktree)) return obs
  return { ...obs, exitedWork: (deps.exitedWork ?? readExitedWork)(worktree) ?? 'unreadable' }
}

const SPEND_PHASES: ReadonlySet<Phase> = new Set([
  'spawning',
  'planning',
  'implementing',
  'reviewing',
  'parked',
])

/** Every agent the claim spawned counts, so a successor or reviewer never resets the spend; a name with no row is unknown. */
async function claimSpend(claim: Claim, roster: Roster, deps: ObserveDeps): Promise<Observation['spend']> {
  if (claim.seat === undefined || !SPEND_PHASES.has(claim.phase)) return undefined
  const cap = deps.spendCap?.(claim.seat)
  if (cap === undefined) return undefined
  const names = claim.spawned ?? (claim.agentName === undefined ? [] : [claim.agentName])
  const readOne = deps.spend ?? defaultSpend
  const reads = await Promise.all(
    names.map(name => {
      const row = rowNamed(roster, name)
      return row === undefined
        ? Promise.resolve<TranscriptSpendRead>({ ok: false, path: name, reason: 'no agent row' })
        : spendOrUnknown(readOne, row)
    }),
  )
  return { claim: sumSpend(reads), cap }
}

/** A read that throws or rejects is that one agent's unknown, so it never loses the tick's other observations (CC-729). */
async function spendOrUnknown(
  readOne: (agent: AgentIdentity) => Promise<TranscriptSpendRead>,
  row: AgentIdentity,
): Promise<TranscriptSpendRead> {
  try {
    return await readOne(row)
  } catch (err) {
    return { ok: false, path: row.name, reason: err instanceof Error ? err.message : String(err) }
  }
}

function withSlices(obs: Observation, claim: Claim, deps: ObserveDeps): Observation {
  const planPath = obs.report?.plan ?? planPathFor(path.join(deps.root, claim.initiative), claim.taskId)
  const text = (deps.readFile ?? readFileOrUndefined)(planPath)
  if (text === undefined) return { ...obs, sliceProblems: [`no plan file at ${planPath}`] }
  const read = readSlices(text)
  return read.slices === undefined
    ? { ...obs, sliceProblems: read.problems }
    : { ...obs, slices: read.slices }
}

export const memo = <T>(read: () => T): (() => T) => {
  let cached: { value: T } | undefined
  return () => (cached ??= { value: read() }).value
}

/** Shepherd unreadable withholds the observation: a down service must not read as an unregistered PR. */
function withShepherd(obs: Observation, claim: Claim, deps: ObserveDeps): Observation | string {
  if (claim.pr === undefined) return obs
  const target = shepherdTarget(claim.pr)
  if (target === undefined) return { ...obs, shepherd: {} }
  const rows = deps.shepherdRows?.()
  if (rows === undefined) return `could not read Shepherd's status for ${claim.pr}`
  const row = rowFor(rows, target)
  if (row?.phase !== 'done') return { ...obs, shepherd: row === undefined ? {} : { row } }
  const landed = (deps.landed ?? (t => shepherdLanded(t)))(target)
  if (landed === undefined) return `could not read Shepherd's timeline for ${claim.pr}`
  return { ...obs, shepherd: { row, landed } }
}

/** Live roster rows this tick's ledger spawned or `others` names (the decider), plus spawns still waiting for their row. */
export function liveBurndownAgents(claims: Claim[], roster: Roster, others: string[] = []): number {
  const ours = new Set([...claims.flatMap(c => c.spawned ?? []), ...others])
  const live = roster.agents.filter(a => ours.has(a.name) && LIVE.has(a.state)).length
  const pending = claims.filter(
    c => c.phase === 'spawning' && rowNamed(roster, c.agentName) === undefined,
  ).length
  return live + pending
}

/** Every worktree git lists under `<repo>/.worktrees`, by directory name. */
export function worktreesUnder(repo: string, exec: Runner = run): string[] | undefined {
  const result = exec(GIT_BIN, ['worktree', 'list', '--porcelain'], repo)
  if (result.status !== 0) return undefined
  const base = path.join(repo, '.worktrees') + path.sep
  return result.stdout
    .split('\n')
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length))
    .filter(p => p.startsWith(base))
    .map(p => path.basename(p))
}

/**
 * Counts against the tick's ceilings; an unreadable repo counts as full, so the tick cuts nothing there.
 * `prefixes` is every agent-name prefix the tick spawns under: `bd` plus each enabled seat's (CC-205).
 * Reviewer trees sit in the broker's separate reviewer pool (CC-1040), so `total` counts implementer trees only.
 */
export function worktreeUse(
  names: string[] | undefined,
  budget: number,
  config: { maxWorktreesPerRepo: number; reserveWorktrees: number },
  prefixes: readonly string[] = [DEFAULT_NAME_PREFIX],
): WorktreeUse {
  const totalCeiling = Math.max(0, budget - config.reserveWorktrees)
  if (names === undefined)
    return {
      total: totalCeiling,
      ours: 0,
      reviewers: 0,
      totalCeiling,
      oursCeiling: config.maxWorktreesPerRepo,
    }
  const reviewers = names.filter(isReviewerTreeName).length
  return {
    total: names.length - reviewers,
    reviewers,
    ours: names.filter(n => prefixes.some(p => n.startsWith(`${p}-`))).length,
    totalCeiling,
    oursCeiling: config.maxWorktreesPerRepo,
  }
}

/**
 * A branch or worktree named for `agentName` that exists before the tick spawned
 * it: a spawn that failed after allocation leaves both behind with no claim
 * (CC-167), and the worktree strategy would adopt that stale branch.
 */
export function orphanAt(repo: string, agentName: string, exec: Runner = run): string | undefined {
  const branch = `${BRANCH_PREFIX}${agentName}`
  const dir = worktreePathFor(repo, agentName)
  const hasBranch =
    exec(GIT_BIN, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo).status === 0
  const hasDir = fs.existsSync(dir)
  if (!hasBranch && !hasDir) return undefined
  const found = [hasBranch ? `branch ${branch}` : '', hasDir ? `worktree ${dir}` : '']
    .filter(Boolean)
    .join(' and ')
  return `${found} already exist with no ledger claim, likely from a spawn that failed before registering; inspect it, then reclaim with \`agent-chat agent worktrees --prune\``
}

/** `origin/HEAD`'s branch, which the brief's first step merges from; `main` when the clone has none. */
export function defaultBranch(repo: string, exec: Runner = run): string {
  const result = exec(GIT_BIN, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], repo)
  const ref = result.status === 0 ? result.stdout.trim() : ''
  return ref.startsWith('origin/') ? ref.slice('origin/'.length) : 'main'
}
