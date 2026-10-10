import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { SHEPHERD_BIN, SHEPHERD_STATUS_ARGS } from '../burndown/shepherd.js'
import { childEnv } from '../burndown/exec.js'
import type { AgentIdentity } from '../../protocol.js'
import type { ParkTarget } from './park.js'

/**
 * CC-904: Shepherd resumes a finished implementer or reviewer for a fix round, and a
 * retired name cannot be resumed. So any finished agent whose branch has an open PR,
 * or that a live Shepherd run names, is skipped by every bulk or automatic retire.
 * Both reads fail closed: what cannot be read is a skip, never a retire.
 */

export const OPEN_PR_REASON = 'open PR (Shepherd wakes it)'

/** A Shepherd run that has not finished, reduced to what can name an agent. */
export interface ShepherdRun {
  branch: string | null
  /** The run's implementer and reviewer names, when Shepherd lists them. */
  names: string[]
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
  if (runs.some(r => (r.branch !== null && branches.has(r.branch)) || r.names.includes(agent.name)))
    return OPEN_PR_REASON
  if (target === undefined) return undefined
  try {
    return (await port.hasOpenPr(target.gitRoot, target.branch)) ? OPEN_PR_REASON : undefined
  } catch (err) {
    return `could not tell whether ${target.branch} has an open PR (${firstLine(err)})`
  }
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
    }))
}

async function readActiveRuns(): Promise<ShepherdRun[]> {
  const { stdout } = await execFileAsync(SHEPHERD_BIN, SHEPHERD_STATUS_ARGS, {
    env: childEnv(),
    encoding: 'utf8',
    timeout: READ_TIMEOUT_MS,
    maxBuffer: STATUS_MAX_BYTES,
  })
  return parseActiveRuns(stdout)
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
  activeRuns: readActiveRuns,
  hasOpenPr: readOpenPr,
}
