import fs from 'node:fs'
import path from 'node:path'
import type { AgentIdentity } from '../../protocol.js'
import { BRANCH_PREFIX } from '../isolation/worktree.js'
import { finalAssistantText } from '../turns.js'
import { claimKey, type InboxMessage, type Observation } from './advance.js'
import { planPathFor } from './brief.js'
import { run, type Runner } from './exec.js'
import type { Claim } from './ledger.js'
import type { WorktreeUse } from './plan.js'
import { parseReport, parseSlices } from './report.js'
import { assessDiff, GIT_BIN, type DiffVerdict } from './review-diff.js'
import { worktreePathFor } from './trust-gate.js'

/**
 * The tick's reads: what the broker, the transcripts, git and GitHub say about
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
  pr?: (url: string) => Observation['pr'] | undefined
  readFile?: (file: string) => string | undefined
}

export interface Observed {
  observations: Map<string, Observation>
  /** Claims the tick could not read this run, and why; `advance` sees nothing for them. */
  unread: string[]
}

const LIVE = new Set(['spawning', 'live', 'detached'])
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

const defaultFinalText = (agent: AgentIdentity): string | undefined =>
  finalAssistantText(agent.cwd, agent.sessionId, agent.configDir === '' ? undefined : agent.configDir)

export async function observe(claims: Claim[], roster: Roster, deps: ObserveDeps): Promise<Observed> {
  const observations = new Map<string, Observation>()
  const unread: string[] = []
  for (const claim of claims) {
    const result = await observeClaim(claim, roster, deps)
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
  if (claim.phase === 'awaiting-merge') return withPr(obs, claim, deps)
  if (row === undefined || !FINISHED.has(row.state) || claim.phase === 'spawning') return obs
  const text = (deps.finalText ?? defaultFinalText)(row)
  if (text !== undefined) obs.report = parseReport(text)
  if (claim.phase === 'planning') return withSlices(obs, claim, deps)
  if (claim.phase === 'implementing' && claim.worktree !== undefined)
    obs.diff = (deps.diff ?? assessDiff)(claim.worktree)
  if (claim.phase === 'reviewing') return withPr(obs, claim, deps)
  return obs
}

function withSlices(obs: Observation, claim: Claim, deps: ObserveDeps): Observation {
  const planPath = obs.report?.plan ?? planPathFor(path.join(deps.root, claim.initiative), claim.taskId)
  const text = (deps.readFile ?? readFileOrUndefined)(planPath)
  const slices = text === undefined ? undefined : parseSlices(text)
  return slices === undefined ? obs : { ...obs, slices }
}

/** A PR the tick cannot read withholds the observation: a transient `gh` failure must not read as a failed review. */
function withPr(obs: Observation, claim: Claim, deps: ObserveDeps): Observation | string {
  if (claim.pr === undefined) return obs
  const pr = (deps.pr ?? prState)(claim.pr)
  return pr === undefined ? `could not read ${claim.pr} through gh` : { ...obs, pr }
}

interface Rollup {
  state?: string
  statusCheckRollup?: { conclusion?: string | null; state?: string | null; status?: string | null }[]
}

const PASSED = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL'])
const FAILED = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'ERROR', 'STARTUP_FAILURE'])

/** `gh pr view --json state,statusCheckRollup`, read into the phase machine's shape; no checks is pending. */
export function readRollup(json: string): Observation['pr'] | undefined {
  let parsed: Rollup
  try {
    parsed = JSON.parse(json) as Rollup
  } catch {
    return undefined
  }
  const state = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' }[parsed.state ?? ''] as
    'open' | 'merged' | 'closed' | undefined
  if (state === undefined) return undefined
  const results = (parsed.statusCheckRollup ?? []).map(c =>
    (c.conclusion || c.state || c.status || '').toUpperCase(),
  )
  const checks = results.some(r => FAILED.has(r))
    ? 'fail'
    : results.length > 0 && results.every(r => PASSED.has(r))
      ? 'pass'
      : 'pending'
  return { state, checks }
}

export function prState(url: string, exec: Runner = run): Observation['pr'] | undefined {
  const result = exec('gh', ['pr', 'view', url, '--json', 'state,statusCheckRollup'])
  return result.status === 0 ? readRollup(result.stdout) : undefined
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

/** Counts against the tick's ceilings; an unreadable repo counts as full, so the tick cuts nothing there. */
export function worktreeUse(
  names: string[] | undefined,
  budget: number,
  config: { maxWorktreesPerRepo: number; reserveWorktrees: number },
): WorktreeUse {
  const totalCeiling = Math.max(0, budget - config.reserveWorktrees)
  if (names === undefined)
    return { total: totalCeiling, ours: 0, totalCeiling, oursCeiling: config.maxWorktreesPerRepo }
  return {
    total: names.length,
    ours: names.filter(n => n.startsWith('bd-')).length,
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
