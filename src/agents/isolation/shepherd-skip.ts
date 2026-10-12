import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { SHEPHERD_BIN, SHEPHERD_STATUS_ARGS } from '../burndown/shepherd.js'
import { childEnv, describeExecFailure } from '../burndown/exec.js'
import type { AgentIdentity } from '../../protocol.js'
import type { ParkTarget } from './park.js'

/**
 * CC-904: a finished agent whose branch has an open PR that no Shepherd run has taken is
 * skipped by every bulk or automatic retire: nothing else will wake it for a fix round.
 * CC-950: once a live run names the agent or its branch, Shepherd owns the PR and the
 * agent is retired and parked, unless the run names it as reviewer. Both reads fail closed: what cannot be read is a skip.
 */

export const OPEN_PR_REASON = 'open PR (Shepherd wakes it)'

/** A Shepherd run that has not finished, reduced to what can name an agent. */
export interface ShepherdRun {
  branch: string | null
  /** The run's implementer and reviewer names, when Shepherd lists them. */
  names: string[]
  /** CC-950: the implementer alone, since Shepherd replaces it with a successor but resumes a reviewer by name. */
  implementer: string | null
  /** CC-754: Shepherd's phase; `fixing` holds from an implementer wake until a new head arrives. */
  phase: string
}

export interface ShepherdSkipPort {
  /** Every unfinished run; rejects when Shepherd cannot be read. */
  activeRuns(): Promise<ShepherdRun[]>
  /** Whether `branch` has an open PR; rejects when that cannot be told. */
  hasOpenPr(gitRoot: string, branch: string): Promise<boolean>
}

const firstLine = (err: unknown): string => String((err as Error).message ?? err).split('\n')[0] ?? ''

/** Why `agent` must not be retired under CC-904, or undefined when it may be. */
export async function shepherdSkip(
  port: ShepherdSkipPort,
  agent: AgentIdentity,
  target: ParkTarget | undefined,
): Promise<string | undefined> {
  let runs: ShepherdRun[]
  try {
    runs = await port.activeRuns()
  } catch (err) {
    return `Shepherd could not be read (${firstLine(err)}), so a run naming it cannot be ruled out`
  }
  const branches = new Set([`agent-chat/${agent.name}`, ...(target ? [target.branch] : [])])
  const holds = (r: ShepherdRun): boolean =>
    (r.branch !== null && branches.has(r.branch)) || r.names.includes(agent.name)
  // CC-950: a run's implementer may go, since a fix round starts a successor; a reviewer stays for verdict correction.
  const registered = runs.filter(holds)
  if (registered.length > 0)
    return registered.every(r => r.implementer === agent.name || r.names.includes(agent.name) === false)
      ? undefined
      : OPEN_PR_REASON
  if (target === undefined) return undefined
  try {
    return (await port.hasOpenPr(target.gitRoot, target.branch)) ? OPEN_PR_REASON : undefined
  } catch (err) {
    return `could not tell whether ${target.branch} has an open PR (${firstLine(err)})`
  }
}

const FIX_ROUND_PHASE = 'fixing'

/**
 * CC-754: why `agent`'s tree must not be parked now, or undefined when it may be. A run in a fix round has
 * queued (or is about to queue) a wake for its implementer; parking would leave that wake a missing cwd.
 */
export async function fixRoundBlocker(
  port: ShepherdSkipPort,
  agent: AgentIdentity,
  target: ParkTarget | undefined,
): Promise<string | undefined> {
  let runs: ShepherdRun[]
  try {
    runs = await port.activeRuns()
  } catch (err) {
    return `Shepherd could not be read (${firstLine(err)}), so a fix round for its PR cannot be ruled out`
  }
  const branches = new Set([`agent-chat/${agent.name}`, ...(target ? [target.branch] : [])])
  const fixing = runs.find(
    r =>
      r.phase === FIX_ROUND_PHASE &&
      ((r.branch !== null && branches.has(r.branch)) || r.implementer === agent.name),
  )
  if (fixing === undefined) return undefined
  const branch = fixing.branch ?? target?.branch ?? `agent-chat/${agent.name}`
  return `Shepherd run for ${branch} is in a fix round (phase fixing); parking would strand its wake`
}

const execFileAsync = promisify(execFile)
const READ_TIMEOUT_MS = 15_000
/** Shepherd lists its finished runs too, so the answer can outgrow execFile's 1 MB default. */
const STATUS_MAX_BYTES = 64 * 1024 * 1024
const FINISHED = new Set(['done', 'failed', 'cancelled'])

const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** A row in a phase this build does not know counts as live: skipping costs a line, a wrong retire a fix round. */
export function parseActiveRuns(stdout: string): ShepherdRun[] {
  const parsed: unknown = JSON.parse(stdout)
  if (!Array.isArray(parsed)) throw new Error('shepherd status is not a JSON array')
  return parsed
    .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
    .filter(row => !FINISHED.has(String(row.phase)))
    .map(row => ({
      branch: text(row.branch) ?? null,
      names: [row.implementer, row.reviewer].map(text).filter((n): n is string => n !== undefined),
      implementer: text(row.implementer) ?? null,
      phase: String(row.phase),
    }))
}

export interface ReadActiveRunsOptions {
  bin?: string
  timeoutMs?: number
}

/**
 * CC-1096: runs in HOME, since the broker's own cwd can be a removed agent tree, and a failure
 * names exit or signal, timeout, elapsed ms, cwd and stderr instead of "Command failed: <argv>".
 */
export async function readActiveRuns({
  bin = SHEPHERD_BIN,
  timeoutMs = READ_TIMEOUT_MS,
}: ReadActiveRunsOptions = {}): Promise<ShepherdRun[]> {
  const cwd = homedir()
  const started = performance.now()
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync(bin, SHEPHERD_STATUS_ARGS, {
      cwd,
      env: childEnv(),
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: STATUS_MAX_BYTES,
    }))
  } catch (err) {
    throw new Error(describeExecFailure(err, { cwd, elapsedMs: performance.now() - started }))
  }
  try {
    return parseActiveRuns(stdout)
  } catch (err) {
    throw new Error(`parsed ${stdout.length} bytes: ${(err as Error).message}`.split('\n')[0])
  }
}

/** A repo with no origin has nowhere to hold a PR; otherwise `gh` answers, and its failure rejects. */
async function readOpenPr(gitRoot: string, branch: string): Promise<boolean> {
  const opts = { cwd: gitRoot, env: childEnv(), encoding: 'utf8' as const, timeout: READ_TIMEOUT_MS }
  const remote = await execFileAsync('git', ['remote', 'get-url', 'origin'], opts).catch(() => null)
  if (remote === null) return false
  const args = ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number', '--limit', '1']
  const { stdout } = await execFileAsync('gh', args, opts)
  const prs: unknown = JSON.parse(stdout)
  if (!Array.isArray(prs)) throw new Error('gh pr list did not answer a JSON array')
  return prs.length > 0
}

/** The broker's production reads; tests pass a fake. */
export const cliShepherdSkipPort: ShepherdSkipPort = {
  activeRuns: () => readActiveRuns(),
  hasOpenPr: readOpenPr,
}
