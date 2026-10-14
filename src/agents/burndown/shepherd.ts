import { z } from 'zod'
import { logEvent } from '../../broker/log.js'
import { run, type Runner, type RunResult } from '../../exec.js'
import {
  FINISHED_PHASES,
  SHEPHERD_BIN,
  SHEPHERD_STATUS_ALL_ARGS,
  rowFor,
  shepherdRows,
  targetRef,
  type ShepherdRow,
  type ShepherdTarget,
} from '../../shepherd-client.js'

// The read client moved to src/shepherd-client.ts (CC-1216); re-exported so burndown and its tests need no
// import churn during the NA3 port freeze. C3 (CC-1197) removes it.
export {
  FINISHED_PHASES,
  SHEPHERD_BIN,
  SHEPHERD_STATUS_ALL_ARGS,
  SHEPHERD_STATUS_ARGS,
  parseShepherdRows,
  rowFor,
  shepherdRows,
  shepherdRowsAsync,
  shepherdTarget,
  targetRef,
  type ShepherdRow,
  type ShepherdTarget,
} from '../../shepherd-client.js'

/**
 * Burndown's write door to Shepherd, the factory's PR-shepherding service: the
 * `titan-factory shepherd` CLI. Shepherd owns CI, review and merge for a
 * registered PR; burndown registers a finished worker's PR, holds it, and reads
 * its timeline. Every read that fails is "could not tell", never a phase.
 */

/** sysexits DATAERR: Shepherd refused the registration (a denied repo, a branch already taken), as opposed to being down. */
const REFUSED_EXIT = 65

type Log = (event: string, detail: Record<string, unknown>) => void

const TimelineStep = z.object({ kind: z.string(), stepId: z.string().optional() })

/** Whether the run recorded `sh-landed`, its one merged exit; a finished run may also have stopped on a closed PR. */
export function shepherdLanded(t: ShepherdTarget, exec: Runner = run): boolean | undefined {
  const result = exec(SHEPHERD_BIN, ['shepherd', 'timeline', targetRef(t), '--json'])
  if (result.status !== 0) return undefined
  try {
    const parsed = z.object({ entries: z.array(TimelineStep) }).safeParse(JSON.parse(result.stdout))
    if (!parsed.success) return undefined
    return parsed.data.entries.some(e => e.kind === 'step' && e.stepId?.split(':')[0] === 'sh-landed')
  } catch {
    return undefined
  }
}

export interface Registration {
  target: ShepherdTarget
  /** `<initiative>/<task id>`, as Shepherd's `--task` takes it. */
  task: string
  /** The agent Shepherd wakes to push fixes. */
  implementer: string
  /** The PR's current head; when known, a listed row at any other head is stale. */
  headSha?: string
  /** Shepherd's `--kind`; absent, the flag is left off so a worker's own kind survives. */
  kind?: ShepherdKind
  /** CC-952: the open PR this one is stacked on, so Shepherd lands it after that one (`--after`). */
  after?: ShepherdTarget
}

export type ShepherdKind = 'correctness' | 'security' | 'feature' | 'refactor' | 'unknown'

/** The PR's head sha as GitHub reports it now; a refused PR has no Shepherd row to read it from. */
export function prHeadOf(target: ShepherdTarget, exec: Runner = run): string | undefined {
  const result = exec('gh', ['api', `repos/${target.repo}/pulls/${target.pr}`, '--jq', '.head.sha'])
  const sha = result.status === 0 ? result.stdout.trim() : ''
  return /^[0-9a-f]{7,64}$/.test(sha) ? sha : undefined
}

export type RegisterReply = { ok: true } | { ok: false; refused: boolean; reason: string }

/** Idempotent on `repo#pr` at Shepherd's end, so a repeat after an unanswered call starts no second run. */
export function registerWithShepherd(
  reg: Registration,
  exec: Runner = run,
  log: Log = logEvent,
): RegisterReply {
  // A worker registers its own PR with a --kind; a repeat here would clear it.
  const listed = shepherdRows(exec)
  const row = listed && rowFor(listed, reg.target)
  if (row && isLiveAtHead(row, reg.headSha)) return { ok: true }
  const after = reg.after ?? stackedOn(reg.target, exec)
  return shepherdRegister(after === undefined ? reg : { ...reg, after }, exec, log)
}

/**
 * CC-952: the open PR whose head branch this PR's base is, so a stacked PR
 * lands after it; undefined for a PR on the default branch or when GitHub does
 * not answer, which registers it unstacked as before.
 */
export function stackedOn(target: ShepherdTarget, exec: Runner = run): ShepherdTarget | undefined {
  const bases = exec('gh', [
    'api',
    `repos/${target.repo}/pulls/${target.pr}`,
    '--jq',
    '[.base.ref, .base.repo.default_branch] | @tsv',
  ])
  if (bases.status !== 0) return undefined
  const [base, defaultBranch] = bases.stdout.trim().split('\t')
  if (!base || !defaultBranch || base === defaultBranch) return undefined
  const owner = target.repo.split('/')[0] as string
  const query = `head=${encodeURIComponent(`${owner}:${base}`)}`
  const below = exec('gh', ['api', `repos/${target.repo}/pulls?state=open&${query}`, '--jq', '.[0].number'])
  const pr = below.status === 0 ? Number(below.stdout.trim()) : NaN
  return Number.isInteger(pr) && pr > 0 && pr !== target.pr ? { repo: target.repo, pr } : undefined
}

/** Commander's answer from a Shepherd built before `register --after` existed. */
const AFTER_UNSUPPORTED = /unknown option '--after'/

/** `shepherd register` itself, with no listing first; a repeat updates the run in place. */
export function shepherdRegister(reg: Registration, exec: Runner = run, log: Log = logEvent): RegisterReply {
  const args = [
    'shepherd',
    'register',
    targetRef(reg.target),
    '--task',
    reg.task,
    '--implementer',
    reg.implementer,
    ...(reg.kind === undefined ? [] : ['--kind', reg.kind]),
    '--json',
  ]
  if (reg.after === undefined) return replyOf(exec(SHEPHERD_BIN, args))
  const stacked = exec(SHEPHERD_BIN, [...args, '--after', targetRef(reg.after)])
  if (stacked.status === 0 || !AFTER_UNSUPPORTED.test(stacked.stderr ?? '')) return replyOf(stacked)
  log('burndown_shepherd_after_unsupported', { target: targetRef(reg.target), after: targetRef(reg.after) })
  return replyOf(exec(SHEPHERD_BIN, args))
}

/** CC-931: `shepherd hold`, so no merge goes through until someone releases the run; `reason` is what the seat reads. */
export function shepherdHold(target: ShepherdTarget, reason: string, exec: Runner = run): RegisterReply {
  return replyOf(exec(SHEPHERD_BIN, ['shepherd', 'hold', targetRef(target), '--reason', reason, '--json']))
}

function replyOf(result: RunResult): RegisterReply {
  if (result.status === 0) return { ok: true }
  const reason =
    firstLine(result.stderr) ?? (result.status === null ? 'did not run' : `exit ${result.status}`)
  return { ok: false, refused: result.status === REFUSED_EXIT, reason }
}

/** What `shepherd status --json` lists, read from raw rows so one the schema skips as malformed still counts. */
export interface ShepherdListing {
  /** Every lowercased `repo#pr`. */
  prs: Set<string>
  /** Every row's branch in any repo, a branch-only run awaiting its PR (`pr: null`) included. */
  branches: Set<string>
}

/** Undefined when Shepherd is down or the answer is not a JSON array. */
export function shepherdListed(exec: Runner = run): ShepherdListing | undefined {
  const result = exec(SHEPHERD_BIN, SHEPHERD_STATUS_ALL_ARGS)
  if (result.status !== 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  const listing: ShepherdListing = { prs: new Set(), branches: new Set() }
  for (const raw of parsed) {
    const ref = ListedRef.safeParse(raw)
    if (ref.success) listing.prs.add(targetRef(ref.data).toLowerCase())
    const branch = ListedBranch.safeParse(raw)
    if (branch.success) listing.branches.add(branch.data.branch)
  }
  return listing
}

const ListedRef = z.object({ repo: z.string(), pr: z.number().int() })
const ListedBranch = z.object({ branch: z.string().min(1) })

/** A finished run, or one at another head, no longer watches this PR. */
const isLiveAtHead = (row: ShepherdRow, headSha: string | undefined): boolean =>
  !FINISHED_PHASES.includes(row.phase) && (headSha === undefined || row.headSha === headSha)

const firstLine = (text: string | undefined): string | undefined =>
  text
    ?.split('\n')
    .map(l => l.trim())
    .find(l => l.length > 0)
    ?.slice(0, 300)
