import fs from 'node:fs'
import path from 'node:path'
import type { AgentIdentity } from '../../protocol.js'
import { BRANCH_PREFIX } from '../isolation/worktree.js'
import { findTranscript } from '../transcript.js'
import { readTranscriptSpend, type TranscriptSpendRead } from '../transcript-spend.js'
import { finalAssistantText, readActivity } from '../turns.js'
import { claimKey, type InboxMessage, type Observation } from './advance.js'
import { planPathFor } from './brief.js'
import { run, type Runner } from './exec.js'
import { AGENT_PHASES, type Claim, type Phase } from './ledger.js'
import { DEFAULT_NAME_PREFIX, type WorktreeUse } from './plan.js'
import { readProgress, type Progress } from './progress.js'
import { defaultAutonomyRoot, loadPolicy } from './policy.js'
import { parseReport, readSlices } from './report.js'
import { sumSpend } from './spend-cap.js'
import type { ActivityRead } from './stall.js'
import { assessDiff, GIT_BIN, type DiffVerdict } from './review-diff.js'
import {
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
}

export interface ObserveDeps {
  inboxSince: (name: string, afterId: number) => Promise<InboxMessage[]>
  /** The active-work root, where a planner's plan file lives. */
  root: string
  finalText?: (agent: AgentIdentity) => string | undefined
  diff?: (cwd: string) => DiffVerdict
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
}

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
  for (const claim of claims) {
    const result = await observeClaim(claim, roster, once)
    if (typeof result === 'string') unread.push(`${claimKey(claim)}: ${result}`)
    else observations.set(claimKey(claim), result)
  }
  return { observations, unread }
}

async function observeClaim(claim: Claim, roster: Roster, deps: ObserveDeps): Promise<Observation | string> {
  const row = rowNamed(roster, claim.agentName)
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
  if (claim.phase === 'planning') return withSlices(obs, claim, deps)
  if (claim.phase === 'implementing' && claim.worktree !== undefined)
    obs.diff = (deps.diff ?? assessDiff)(claim.worktree)
  if (claim.phase === 'reviewing') return withShepherd(obs, claim, deps)
  return obs
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
        : readOne(row)
    }),
  )
  return { claim: sumSpend(reads), cap }
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

const memo = <T>(read: () => T): (() => T) => {
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
 */
export function worktreeUse(
  names: string[] | undefined,
  budget: number,
  config: { maxWorktreesPerRepo: number; reserveWorktrees: number },
  prefixes: readonly string[] = [DEFAULT_NAME_PREFIX],
): WorktreeUse {
  const totalCeiling = Math.max(0, budget - config.reserveWorktrees)
  if (names === undefined)
    return { total: totalCeiling, ours: 0, totalCeiling, oursCeiling: config.maxWorktreesPerRepo }
  return {
    total: names.length,
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
